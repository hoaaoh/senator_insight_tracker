#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CHANNEL_URL =
  "https://www.youtube.com/@%E6%96%B0%E5%8C%97%E5%B8%82%E8%AD%B0%E6%9C%83%E7%B6%B2%E8%B7%AF%E7%9B%B4%E6%92%AD/streams";
const DEFAULT_OUTPUT_DIR = "pipeline/data/video_index";
const DEFAULT_TARGET_YEARS = [114, 115];

const args = parseArgs(process.argv.slice(2));
const channelUrl = args.channelUrl || DEFAULT_CHANNEL_URL;
const outputDir = args.outputDir || DEFAULT_OUTPUT_DIR;
const targetYears = args.years?.length ? args.years : DEFAULT_TARGET_YEARS;
const maxPages = args.maxPages || 20;

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    const [key, value = ""] = arg.split("=");
    if (key === "--channel-url") parsed.channelUrl = value;
    if (key === "--output-dir") parsed.outputDir = value;
    if (key === "--max-pages") parsed.maxPages = Number(value);
    if (key === "--years") {
      parsed.years = value
        .split(",")
        .map((year) => Number(year.trim()))
        .filter(Boolean);
    }
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
node pipeline/tools/crawl-council-youtube-streams.mjs [options]

Options:
  --channel-url=<url>   YouTube channel streams URL
  --years=114,115      ROC years to keep
  --max-pages=20       Maximum continuation pages to fetch
  --output-dir=<dir>   Output directory for JSON and CSV
`);
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      "accept-language": "zh-TW,zh;q=0.9,en;q=0.8",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} ${response.statusText}: ${url}\n${text.slice(0, 500)}`);
  }
  return text;
}

function extractInitialData(html) {
  const match =
    html.match(/var ytInitialData = (.*?);<\/script>/s) ||
    html.match(/window\["ytInitialData"\]\s*=\s*(.*?);<\/script>/s);
  if (!match) throw new Error("Could not find ytInitialData in YouTube page.");
  return JSON.parse(match[1]);
}

function extractInnertubeConfig(html) {
  const apiKey = html.match(/INNERTUBE_API_KEY":"([^"]+)/)?.[1];
  const clientVersion = html.match(/INNERTUBE_CLIENT_VERSION":"([^"]+)/)?.[1];
  const channelId =
    html.match(/externalId":"([^"]+)/)?.[1] ||
    html.match(/channel_id=([^"&]+)/)?.[1] ||
    html.match(/browseId":"(UC[^"]+)/)?.[1];

  if (!apiKey || !clientVersion) {
    throw new Error("Could not find YouTube Innertube API key/client version.");
  }
  return { apiKey, clientVersion, channelId };
}

function textValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.content) return value.content;
  if (value.simpleText) return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || "").join("");
  return "";
}

function walk(object, visit, pathParts = []) {
  if (!object || typeof object !== "object") return;
  visit(object, pathParts);
  for (const [key, value] of Object.entries(object)) {
    walk(value, visit, pathParts.concat(key));
  }
}

function findDuration(lockupViewModel) {
  let duration = "";
  walk(lockupViewModel.contentImage, (node) => {
    if (!duration && node.thumbnailBadgeViewModel?.text) {
      duration = node.thumbnailBadgeViewModel.text;
    }
  });
  return duration;
}

function findThumbnail(lockupViewModel) {
  const sources = lockupViewModel.contentImage?.thumbnailViewModel?.image?.sources || [];
  return sources.at(-1)?.url || sources[0]?.url || "";
}

function metadataParts(lockupViewModel) {
  const rows =
    lockupViewModel.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
  return rows.flatMap((row) =>
    (row.metadataParts || []).map((part) => textValue(part.text)).filter(Boolean),
  );
}

function parseVideoRenderer(videoRenderer) {
  const title = textValue(videoRenderer.title);
  const videoId = videoRenderer.videoId;
  const duration = textValue(videoRenderer.lengthText);
  const parts = [
    textValue(videoRenderer.ownerText),
    textValue(videoRenderer.viewCountText),
    textValue(videoRenderer.publishedTimeText),
  ].filter(Boolean);
  return normalizeVideo({
    videoId,
    title,
    duration,
    metadata: parts,
    thumbnailUrl: videoRenderer.thumbnail?.thumbnails?.at(-1)?.url || "",
  });
}

function parseLockupViewModel(lockupViewModel) {
  const videoId =
    lockupViewModel.contentId ||
    lockupViewModel.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId ||
    "";
  const title = textValue(lockupViewModel.metadata?.lockupMetadataViewModel?.title);
  return normalizeVideo({
    videoId,
    title,
    duration: findDuration(lockupViewModel),
    metadata: metadataParts(lockupViewModel),
    thumbnailUrl: findThumbnail(lockupViewModel),
  });
}

function normalizeVideo(raw) {
  const roc = parseRocDate(raw.title);
  const meeting = classifyMeeting(raw.title);
  const isUpcoming =
    raw.duration === "Upcoming" ||
    raw.duration === "即將直播" ||
    raw.metadata.some((part) => part.includes("Scheduled") || part.includes("預定"));
  const isSignalTest = raw.title.includes("訊號測試");
  const durationSeconds = parseDurationSeconds(raw.duration);
  const status = isUpcoming ? "upcoming" : "archived";

  return {
    video_id: raw.videoId,
    title: raw.title,
    roc_date: roc.rocDate,
    gregorian_date: roc.gregorianDate,
    roc_year: roc.rocYear,
    month: roc.month,
    day: roc.day,
    meeting_type: meeting.type,
    session_label: meeting.sessionLabel,
    duration: raw.duration,
    duration_seconds: durationSeconds,
    status,
    watch_url: raw.videoId ? `https://www.youtube.com/watch?v=${raw.videoId}` : "",
    published_text: raw.metadata.join(" | "),
    thumbnail_url: raw.thumbnailUrl,
    asr_priority: asrPriority({ meetingType: meeting.type, isSignalTest, isUpcoming }),
    needs_asr: !isUpcoming && !isSignalTest,
  };
}

function parseRocDate(title) {
  const match = title.match(/(1\d{2})(\d{2})(\d{2})/);
  if (!match) {
    return { rocDate: "", gregorianDate: "", rocYear: null, month: null, day: null };
  }
  const rocYear = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const year = rocYear + 1911;
  return {
    rocDate: `${match[1]}-${match[2]}-${match[3]}`,
    gregorianDate: `${year}-${match[2]}-${match[3]}`,
    rocYear,
    month,
    day,
  };
}

function classifyMeeting(title) {
  const reviewCommittee = title.match(/第(\d+)審查委員會/);
  let type = "unknown";
  if (title.includes("大會議事影音")) type = "plenary";
  else if (title.includes("程序委員會")) type = "procedure_committee";
  else if (title.includes("法規審查委員會")) type = "regulation_review_committee";
  else if (reviewCommittee) type = `review_committee_${reviewCommittee[1]}`;
  else if (title.includes("訊號測試")) type = "signal_test";

  const sessionMatch = title.match(/_(上午|下午)$/) || title.match(/_(\d{4})_/);
  return {
    type,
    sessionLabel: sessionMatch?.[1] || "",
  };
}

function parseDurationSeconds(duration) {
  if (!duration || duration === "Upcoming") return null;
  const parts = duration.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || null;
}

function asrPriority({ meetingType, isSignalTest, isUpcoming }) {
  if (isSignalTest || isUpcoming) return "skip";
  if (meetingType === "plenary") return "high";
  if (meetingType.includes("committee")) return "medium";
  return "low";
}

function collectVideos(data) {
  const videos = [];
  walk(data, (node) => {
    if (node.lockupViewModel) videos.push(parseLockupViewModel(node.lockupViewModel));
    if (node.videoRenderer) videos.push(parseVideoRenderer(node.videoRenderer));
  });
  return videos.filter((video) => video.video_id && video.title);
}

function findNextContinuation(data) {
  let token = "";
  walk(data, (node, pathParts) => {
    if (token || !node.continuationCommand?.token) return;
    const pathText = pathParts.join(".");
    if (
      pathText.includes("richGridRenderer.contents") ||
      pathText.includes("appendContinuationItemsAction.continuationItems")
    ) {
      token = node.continuationCommand.token;
    }
  });
  return token;
}

async function fetchContinuation({ apiKey, clientVersion, token }) {
  const response = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      "accept-language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "WEB",
          clientVersion,
          hl: "zh-TW",
          gl: "TW",
        },
      },
      continuation: token,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Continuation failed ${response.status} ${response.statusText}\n${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

function dedupeVideos(videos) {
  const byId = new Map();
  for (const video of videos) {
    if (!byId.has(video.video_id)) byId.set(video.video_id, video);
  }
  return Array.from(byId.values());
}

function shouldStopAfterPage(pageVideos) {
  const dated = pageVideos.filter((video) => video.roc_year);
  if (!dated.length || !targetYears.length) return false;
  const minTargetYear = Math.min(...targetYears);
  return dated.every((video) => video.roc_year < minTargetYear);
}

function filterTargetYears(videos) {
  if (!targetYears.length) return videos;
  return videos.filter((video) => targetYears.includes(video.roc_year));
}

function sortVideos(videos) {
  return videos.sort((a, b) => {
    const dateCompare = (b.gregorian_date || "").localeCompare(a.gregorian_date || "");
    if (dateCompare) return dateCompare;
    return (b.title || "").localeCompare(a.title || "");
  });
}

function summarize(videos) {
  const byYear = {};
  const byType = {};
  let asrSeconds = 0;
  for (const video of videos) {
    byYear[video.roc_year] = (byYear[video.roc_year] || 0) + 1;
    byType[video.meeting_type] = (byType[video.meeting_type] || 0) + 1;
    if (video.needs_asr && video.duration_seconds) asrSeconds += video.duration_seconds;
  }
  return {
    total: videos.length,
    by_year: byYear,
    by_meeting_type: byType,
    estimated_asr_hours: Number((asrSeconds / 3600).toFixed(2)),
  };
}

function toCsv(videos) {
  const columns = [
    "video_id",
    "title",
    "roc_date",
    "gregorian_date",
    "roc_year",
    "meeting_type",
    "session_label",
    "duration",
    "duration_seconds",
    "status",
    "watch_url",
    "published_text",
    "asr_priority",
    "needs_asr",
    "thumbnail_url",
  ];
  const rows = [columns.join(",")];
  for (const video of videos) {
    rows.push(columns.map((column) => csvCell(video[column])).join(","));
  }
  return `${rows.join("\n")}\n`;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

async function main() {
  const html = await fetchText(channelUrl);
  const config = extractInnertubeConfig(html);
  let data = extractInitialData(html);
  let token = findNextContinuation(data);
  const allVideos = [];
  const pageStats = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const pageVideos = collectVideos(data);
    allVideos.push(...pageVideos);
    pageStats.push({
      page,
      videos: pageVideos.length,
      first_title: pageVideos[0]?.title || "",
      last_title: pageVideos.at(-1)?.title || "",
    });

    if (!token || shouldStopAfterPage(pageVideos)) break;
    data = await fetchContinuation({
      apiKey: config.apiKey,
      clientVersion: config.clientVersion,
      token,
    });
    token = findNextContinuation(data);
  }

  const videos = sortVideos(filterTargetYears(dedupeVideos(allVideos)));
  const generatedAt = new Date().toISOString();
  const payload = {
    generated_at: generatedAt,
    source: {
      name: "新北市議會網路直播 YouTube streams",
      channel_url: channelUrl,
      channel_id: config.channelId,
    },
    filters: {
      roc_years: targetYears,
      max_pages: maxPages,
    },
    summary: summarize(videos),
    crawl_pages: pageStats,
    videos,
  };

  await mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "ntpc_council_youtube_streams.json");
  const csvPath = path.join(outputDir, "ntpc_council_youtube_streams.csv");
  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(csvPath, toCsv(videos));

  console.log(`Wrote ${videos.length} videos`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
  console.log(JSON.stringify(payload.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
