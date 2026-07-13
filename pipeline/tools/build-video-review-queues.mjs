#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ASR_QUEUE = "pipeline/data/asr_queue/ntpc_council_high_20260501_20260630_1800s.json";
const DEFAULT_OUTPUT_DIR = "viewer/reviewer/queues";
const DEFAULT_DECISIONS_PATH = "viewer/reviewer/video_review_decisions.json";
const DEFAULT_MAX_CHUNK_SECONDS = 90;

const args = parseArgs(process.argv.slice(2));
const asrQueuePath = args.asrQueue || DEFAULT_ASR_QUEUE;
const outputDir = args.outputDir || DEFAULT_OUTPUT_DIR;
const decisionsPath = args.decisions || DEFAULT_DECISIONS_PATH;
const videoId = args.videoId || "";
const maxChunkSeconds = args.maxChunkSeconds || DEFAULT_MAX_CHUNK_SECONDS;
const allowPartial = Boolean(args.allowPartial);

const ISSUES = [
  {
    id: "housing",
    label: "居住都更",
    keywords: ["社宅", "租屋", "租金", "都更", "危老", "居住", "住宅", "違規隔間"],
  },
  {
    id: "transport",
    label: "交通行人",
    keywords: ["交通", "公車", "停車", "捷運", "YouBike", "行人", "路口", "通勤", "車流"],
  },
  {
    id: "energy",
    label: "市場商圈",
    keywords: ["市場", "商圈", "夜市", "攤商", "店家", "府中", "黃石", "湳雅", "三重", "文化"],
  },
  {
    id: "labor",
    label: "地方建設",
    keywords: ["工程", "公園", "道路", "排水", "活動中心", "建設", "修繕", "里", "預算", "淹水"],
  },
  {
    id: "care",
    label: "長照社福",
    keywords: ["長照", "社福", "弱勢", "身障", "老人", "照顧", "關懷", "福利"],
  },
  {
    id: "education",
    label: "托育教育",
    keywords: ["學校", "各校", "家長會", "學生", "教育", "教育局", "校園", "托育", "公托"],
  },
  {
    id: "justice",
    label: "治安詐騙",
    keywords: ["詐騙", "治安", "警力", "監視器", "毒品", "警察", "犯罪"],
  },
];

const ACTION_CUES = [
  "請問",
  "請教",
  "質詢",
  "局長",
  "市長",
  "處長",
  "要求",
  "希望",
  "建議",
  "改善",
  "檢討",
  "資料",
  "報告",
  "預算",
];

const EXCLUSION_PATTERNS = [
  "法定人數不足",
  "休息",
  "散會",
  "詞曲",
  "李宗盛",
  "字幕",
  "音樂",
];

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    const [key, value = ""] = arg.split("=");
    if (key === "--asr-queue") parsed.asrQueue = value;
    if (key === "--video-id") parsed.videoId = value;
    if (key === "--output-dir") parsed.outputDir = value;
    if (key === "--decisions") parsed.decisions = value;
    if (key === "--max-chunk-seconds") parsed.maxChunkSeconds = Number(value);
    if (arg === "--allow-partial") parsed.allowPartial = true;
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
node pipeline/tools/build-video-review-queues.mjs --video-id=<YouTube id>

Options:
  --asr-queue=<path>          ASR queue JSON with jobs and segment CSV paths.
  --video-id=<id>             Build one completed video. Omit to process all completed videos.
  --output-dir=<dir>          Reviewer queue output directory.
  --decisions=<path>          Public decision manifest path.
  --max-chunk-seconds=90      Max merged ASR chunk length.
  --allow-partial             Build a provisional queue from completed jobs.
`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.length)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value.length || row.length) {
    row.push(value);
    if (row.some((cell) => cell.length)) rows.push(row);
  }

  const [headers, ...records] = rows;
  if (!headers) return [];
  return records.map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, record[index] || ""]))
  );
}

function sanitizeId(value) {
  return String(value || "")
    .replaceAll("-", "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 80);
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function countHits(text, cues) {
  return cues.filter((cue) => text.includes(cue)).length;
}

function groupJobsByVideo(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = job.video_id || job.source_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  return groups;
}

function classifyIssue(text) {
  const scores = ISSUES.map((issue) => ({
    ...issue,
    hits: issue.keywords.filter((keyword) => text.includes(keyword)),
  })).sort((a, b) => b.hits.length - a.hits.length);
  const best = scores[0];
  if (!best || best.hits.length === 0) {
    return { issue_id: "", issue_label: "待分類", hits: [] };
  }
  return { issue_id: best.id, issue_label: best.label, hits: best.hits };
}

function analyzeSegments(segments) {
  const normalized = segments.map((segment) => normalizeText(segment.text)).filter(Boolean);
  const counts = new Map();
  for (const text of normalized) counts.set(text, (counts.get(text) || 0) + 1);

  const topTexts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([text, count]) => ({ text, count }));

  const exclusionRows = segments.filter((segment) => countHits(segment.text, EXCLUSION_PATTERNS) > 0);
  const actionCueRows = segments.filter((segment) => countHits(segment.text, ACTION_CUES) > 0);
  const repeatedRatio = segments.length ? (topTexts[0]?.count || 0) / segments.length : 0;
  const exclusionRatio = segments.length ? exclusionRows.length / segments.length : 0;
  const actionCueRatio = segments.length ? actionCueRows.length / segments.length : 0;
  const shouldExclude =
    !segments.length ||
    (segments.length >= 10 && repeatedRatio >= 0.6 && exclusionRatio >= 0.6 && actionCueRatio < 0.05) ||
    (exclusionRatio >= 0.9 && actionCueRows.length === 0);

  const reason = shouldExclude
    ? `排除：重複/程序內容比例高。top="${topTexts[0]?.text || ""}" ${topTexts[0]?.count || 0}/${segments.length}，排除線索 ${exclusionRows.length}/${segments.length}，行動線索 ${actionCueRows.length}/${segments.length}。`
    : `可產生初步 queue：排除線索 ${exclusionRows.length}/${segments.length}，行動線索 ${actionCueRows.length}/${segments.length}。`;

  return {
    shouldExclude,
    reason,
    total_segments: segments.length,
    top_texts: topTexts,
    exclusion_segments: exclusionRows.length,
    action_cue_segments: actionCueRows.length,
    repeated_ratio: Number(repeatedRatio.toFixed(3)),
    exclusion_ratio: Number(exclusionRatio.toFixed(3)),
    action_cue_ratio: Number(actionCueRatio.toFixed(3)),
  };
}

function chunkSegments(segments) {
  const sorted = segments
    .map((segment) => ({
      ...segment,
      start: Number(segment.start_seconds),
      end: Number(segment.end_seconds),
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .sort((a, b) => a.start - b.start);

  const chunks = [];
  let active = null;

  for (const segment of sorted) {
    const shouldStart =
      !active ||
      segment.start - active.end_seconds > 12 ||
      segment.end - active.start_seconds > maxChunkSeconds;

    if (shouldStart) {
      if (active) chunks.push(active);
      active = {
        source_id: segment.source_id,
        video_id: segment.video_id,
        start_seconds: segment.start,
        end_seconds: segment.end,
        texts: [segment.text],
        segment_ids: [segment.segment_id],
      };
    } else {
      active.end_seconds = segment.end;
      active.texts.push(segment.text);
      active.segment_ids.push(segment.segment_id);
    }
  }

  if (active) chunks.push(active);
  return chunks;
}

function watchUrl(videoId, seconds) {
  if (!videoId) return "";
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(seconds))}s`;
}

function embedUrl(videoId, start, end) {
  if (!videoId) return "";
  const params = new URLSearchParams({
    start: String(Math.max(0, Math.floor(start))),
    end: String(Math.max(1, Math.ceil(end))),
    controls: "1",
    enablejsapi: "1",
    rel: "0",
    playsinline: "1",
  });
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

function itemFromChunk(chunk, index) {
  const text = chunk.texts.join(" ").replace(/\s+/g, " ").trim();
  const issue = classifyIssue(text);
  const actionHits = ACTION_CUES.filter((cue) => text.includes(cue));
  const exclusionHits = EXCLUSION_PATTERNS.filter((cue) => text.includes(cue));
  const includeStatus = actionHits.length ? "include" : exclusionHits.length ? "exclude" : "uncertain";
  const actionType = actionHits.length ? "質詢候選" : exclusionHits.length ? "非行動" : "質詢候選";

  return {
    queue_item_id: `video-review-${String(index + 1).padStart(3, "0")}`,
    action_id: "",
    chunk_id: `${chunk.source_id}-video-chunk-${String(index + 1).padStart(3, "0")}`,
    source_id: chunk.source_id,
    source_url: watchUrl(chunk.video_id, chunk.start_seconds),
    video_id: chunk.video_id,
    watch_url: watchUrl(chunk.video_id, chunk.start_seconds),
    embed_url: embedUrl(chunk.video_id, chunk.start_seconds, chunk.end_seconds),
    start_seconds: Number(chunk.start_seconds.toFixed(2)),
    end_seconds: Number(chunk.end_seconds.toFixed(2)),
    representative_id: "unknown",
    representative_name: "",
    suggested_primary_issue: issue.issue_id || "transport",
    suggested_primary_issue_label: issue.issue_label,
    suggested_issue_confidence: issue.hits.length >= 2 ? "medium" : issue.hits.length ? "low" : "none",
    suggested_evidence_role: includeStatus === "exclude" ? "exclude" : "detail",
    suggested_include_status: includeStatus,
    suggested_action_type: actionType,
    suggested_summary: actionHits.length
      ? `質詢候選：${issue.issue_label} ${text.slice(0, 80)}`
      : `待判斷：${text.slice(0, 80)}`,
    suggested_notes: [
      "單支影片 ASR 初步 queue，需人工校對逐字稿、發言者、議題與是否納入。",
      issue.hits.length ? `議題命中：${issue.hits.join("|")}` : "",
      actionHits.length ? `行動線索：${actionHits.join("|")}` : "",
      exclusionHits.length ? `排除線索：${exclusionHits.join("|")}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    evidence_frame: "",
    asr_text: text,
    segment_ids: chunk.segment_ids,
    review_status: "needs_review",
  };
}

async function readSegmentsForJobs(jobs) {
  const rows = [];
  for (const job of jobs) {
    if (job.segments_status !== "ready") continue;
    const text = await readFile(job.segments_csv_path, "utf8");
    rows.push(...parseCsv(text));
  }
  return rows;
}

async function readDecisions() {
  try {
    return JSON.parse(await readFile(decisionsPath, "utf8"));
  } catch {
    return { version: 1, generated_at: "", decisions: [] };
  }
}

async function writeDecisions(nextDecisions) {
  await mkdir(path.dirname(decisionsPath), { recursive: true });
  await writeFile(decisionsPath, `${JSON.stringify(nextDecisions, null, 2)}\n`, "utf8");
}

function upsertDecision(payload, decision) {
  const decisions = (payload.decisions || []).filter((entry) => entry.video_id !== decision.video_id);
  decisions.push(decision);
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    decisions: decisions.sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
  };
}

async function processVideo(jobs) {
  const sortedJobs = jobs.slice().sort((a, b) => a.start_seconds - b.start_seconds);
  const first = sortedJobs[0];
  const allReady = sortedJobs.every((job) => job.segments_status === "ready");
  if (!allReady && !allowPartial) {
    return {
      status: "skipped",
      video_id: first.video_id,
      reason: "仍有 ASR job 尚未完成。",
    };
  }

  const segments = await readSegmentsForJobs(sortedJobs);
  if (!segments.length) {
    return {
      status: "skipped",
      video_id: first.video_id,
      reason: "尚無可用 ASR segments。",
    };
  }
  const analysis = analyzeSegments(segments);
  const sourceId = first.source_id;
  const queueId = `video-${sanitizeId(sourceId)}${allReady ? "" : "-partial"}`;
  const queuePath = `queues/${queueId}.json`;

  if (analysis.shouldExclude) {
    const decisions = await readDecisions();
    await writeDecisions(
      upsertDecision(decisions, {
        video_id: first.video_id,
        source_id: sourceId,
        title: first.title,
        date: first.council_date,
        roc_year: first.council_date_roc?.slice(0, 3) || "",
        status_hint: "excluded",
        status_label: "已排除",
        decision_reason: analysis.reason,
        total_segments: analysis.total_segments,
        top_texts: analysis.top_texts,
        updated_at: new Date().toISOString(),
      })
    );
    return {
      status: "excluded",
      video_id: first.video_id,
      title: first.title,
      reason: analysis.reason,
      analysis,
    };
  }

  const chunks = chunkSegments(segments);
  const items = chunks.map(itemFromChunk);
  const queue = {
    queue_id: queueId,
    title: `${first.title}：ASR 單支影片初步標註`,
    description: "由單支影片 ASR segments 自動合併並以規則初步 labeling，請人工確認是否為有效質詢與議題分類。",
    source_video_id: first.video_id,
    source_id: sourceId,
    council_date: first.council_date,
    generated_at: new Date().toISOString(),
    labeling_method: "video-keyword-rules-v1",
    is_partial: !allReady,
    completed_jobs: sortedJobs.filter((job) => job.segments_status === "ready").length,
    total_jobs: sortedJobs.length,
    analysis,
    items,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, `${queueId}.json`), `${JSON.stringify(queue, null, 2)}\n`, "utf8");

  const decisions = await readDecisions();
  await writeDecisions(
    upsertDecision(decisions, {
      video_id: first.video_id,
      source_id: sourceId,
      title: first.title,
      date: first.council_date,
      roc_year: first.council_date_roc?.slice(0, 3) || "",
      status_hint: "queue_ready",
      status_label: allReady ? "可校正" : "部分可校正",
      decision_reason: allReady ? analysis.reason : `${analysis.reason} 目前僅包含已完成 ASR 的 ${queue.completed_jobs}/${queue.total_jobs} 個 job。`,
      queue_id: queueId,
      queue_path: queuePath,
      item_count: items.length,
      total_segments: analysis.total_segments,
      top_texts: analysis.top_texts,
      updated_at: new Date().toISOString(),
    })
  );

  return {
    status: "queue_ready",
    video_id: first.video_id,
    title: first.title,
    queue_path: queuePath,
    item_count: items.length,
    analysis,
  };
}

const asrQueue = JSON.parse(await readFile(asrQueuePath, "utf8"));
const groups = groupJobsByVideo(asrQueue.jobs || []);
const selectedGroups = videoId ? [groups.get(videoId)].filter(Boolean) : Array.from(groups.values());
if (videoId && !selectedGroups.length) throw new Error(`Could not find video_id: ${videoId}`);

const results = [];
for (const jobs of selectedGroups) {
  results.push(await processVideo(jobs));
}

console.log(JSON.stringify({ asr_queue: asrQueuePath, results }, null, 2));
