#!/usr/bin/env node

function getVideoId(input) {
  try {
    const url = new URL(input);
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.split("/").filter(Boolean)[0] || "";
    }
    return url.searchParams.get("v") || "";
  } catch {
    return input;
  }
}

function getStartSeconds(input) {
  try {
    const url = new URL(input);
    const value = url.searchParams.get("t") || url.searchParams.get("start");
    if (!value) return 0;
    if (/^\d+$/.test(value)) return Number(value);
    const match = value.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    if (!match) return 0;
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  } catch {
    return 0;
  }
}

function decodeJsonString(value) {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");
}

function extractTitle(html) {
  const title = html.match(/<title>(.*?)<\/title>/s)?.[1] || "";
  return title.replace(/\s+-\s+YouTube$/, "").trim();
}

function extractDurationMs(html) {
  return Number(html.match(/["\\]*approxDurationMs["\\]*\s*:\s*["\\]*(\d+)/)?.[1] || 0);
}

function extractCaptionTrackHints(html) {
  const index = html.indexOf("captionTracks");
  if (index < 0) return [];

  const slice = html.slice(index, index + 12000);
  const tracks = [];
  const regex = /"languageCode":"([^"]+)".{0,500}?"name":\{"simpleText":"([^"]+)"/g;
  let match;
  while ((match = regex.exec(slice))) {
    tracks.push({
      languageCode: decodeJsonString(match[1]),
      name: decodeJsonString(match[2]),
    });
  }
  return tracks;
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept-language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(30000),
  });
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    text: await response.text(),
  };
}

const input = process.argv[2];
if (!input) {
  console.error("Usage: node pipeline/tools/check-youtube-captions.mjs <youtube-url-or-video-id>");
  process.exit(1);
}

const videoId = getVideoId(input);
if (!videoId) {
  console.error(`Could not parse video id from: ${input}`);
  process.exit(1);
}

const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
const timedTextUrl = `https://video.google.com/timedtext?type=list&v=${videoId}`;

const [watch, timedText] = await Promise.all([fetchText(watchUrl), fetchText(timedTextUrl)]);
const captionTrackHints = extractCaptionTrackHints(watch.text);
const timedTextHasTracks = timedText.text.trim().length > 0;

const result = {
  videoId,
  inputUrl: input,
  watchUrl,
  title: extractTitle(watch.text),
  startSeconds: getStartSeconds(input),
  durationMs: extractDurationMs(watch.text),
  watchStatus: watch.status,
  timedTextStatus: timedText.status,
  hasCaptionTracksInWatchPage: captionTrackHints.length > 0,
  captionTrackHints,
  timedTextListBytes: Buffer.byteLength(timedText.text),
  timedTextHasTracks,
  needsAsr: !captionTrackHints.length && !timedTextHasTracks,
};

console.log(JSON.stringify(result, null, 2));
