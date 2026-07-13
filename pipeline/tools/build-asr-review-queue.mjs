#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";

const DEFAULT_SEGMENTS_PATH =
  "pipeline/data/transcripts/ntpc-council-youtube-1150429-g_HVtiZC90-000000-000500.segments.csv";
const DEFAULT_OUTPUT_PATH = "viewer/reviewer/asr_review_queue.json";
const DEFAULT_MAX_CHUNK_SECONDS = 75;

const args = parseArgs(process.argv.slice(2));
const segmentsPath = args.segments || DEFAULT_SEGMENTS_PATH;
const outputPath = args.output || DEFAULT_OUTPUT_PATH;
const maxChunkSeconds = args.maxChunkSeconds || DEFAULT_MAX_CHUNK_SECONDS;

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
    keywords: [
      "學校",
      "各校",
      "家長會",
      "孩子",
      "學生",
      "教育",
      "教育局",
      "校園",
      "兒童",
      "托育",
      "公托",
      "文具",
      "圖書",
      "禮物",
    ],
  },
  {
    id: "justice",
    label: "治安詐騙",
    keywords: ["詐騙", "治安", "警力", "監視器", "毒品", "警察", "犯罪"],
  },
];

const ACTION_TYPE_RULES = [
  {
    type: "質詢",
    cues: ["請問", "想請教", "請教", "局長", "市長", "處長", "質詢"],
  },
  {
    type: "要求改善",
    cues: ["要求", "希望", "建議", "改善", "處理", "檢討", "研議", "可不可以", "要不要"],
  },
  {
    type: "索取資料",
    cues: ["資料", "提供", "報告", "名單", "數據", "清冊"],
  },
  {
    type: "程序/開場",
    cues: ["現在開始", "開會", "議程", "宣讀", "休息", "散會", "報告事項", "程序"],
  },
];

const NON_ACTION_CUES = ["介紹", "歷史", "文化", "故事", "感謝", "影片", "宣傳"];

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    const [key, value = ""] = arg.split("=");
    if (key === "--segments") parsed.segments = value;
    if (key === "--output") parsed.output = value;
    if (key === "--max-chunk-seconds") parsed.maxChunkSeconds = Number(value);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
node pipeline/tools/build-asr-review-queue.mjs [options]

Options:
  --segments=<path>            ASR segments CSV
  --output=<path>              Output reviewer queue JSON
  --max-chunk-seconds=75       Maximum chunk duration
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
      segment.job_id !== active.job_id ||
      segment.start - active.end_seconds > 8 ||
      segment.end - active.start_seconds > maxChunkSeconds;

    if (shouldStart) {
      if (active) chunks.push(active);
      active = {
        job_id: segment.job_id,
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

function classifyIssue(text) {
  const scores = ISSUES.map((issue) => {
    const hits = issue.keywords.filter((keyword) => text.includes(keyword));
    return { ...issue, score: hits.length, hits };
  }).sort((a, b) => b.score - a.score);

  const best = scores[0];
  if (!best || best.score === 0) {
    return {
      issue_id: "",
      issue_label: "",
      issue_hits: "",
      issue_confidence: "none",
    };
  }

  return {
    issue_id: best.id,
    issue_label: best.label,
    issue_hits: best.hits.join("|"),
    issue_confidence: best.score >= 2 ? "medium" : "low",
  };
}

function classifyAction(text) {
  const scored = ACTION_TYPE_RULES.map((rule) => ({
    ...rule,
    hits: rule.cues.filter((cue) => text.includes(cue)),
  })).sort((a, b) => b.hits.length - a.hits.length);
  const best = scored[0];
  const nonActionHits = NON_ACTION_CUES.filter((cue) => text.includes(cue));

  if ((!best || best.hits.length === 0) && nonActionHits.length) {
    return {
      include_status: "exclude",
      action_type: "非行動",
      evidence_role: "exclude",
      action_cues: "",
      non_action_cues: nonActionHits.join("|"),
    };
  }

  if (!best || best.hits.length === 0) {
    return {
      include_status: "uncertain",
      action_type: "質詢候選",
      evidence_role: "detail",
      action_cues: "",
      non_action_cues: nonActionHits.join("|"),
    };
  }

  return {
    include_status: best.type === "程序/開場" ? "exclude" : "include",
    action_type: best.type,
    evidence_role: best.type === "程序/開場" ? "exclude" : "detail",
    action_cues: best.hits.join("|"),
    non_action_cues: nonActionHits.join("|"),
  };
}

function makeIntent({ issue, action, text }) {
  if (action.action_type === "非行動" || action.action_type === "程序/開場") {
    return "此段可能不是議員質詢行動，需人工確認是否排除。";
  }
  const issueText = issue.issue_label ? `${issue.issue_label}相關` : "";
  const clean = text.replace(/\s+/g, " ").slice(0, 80);
  const actionText = action.action_type.endsWith("候選") ? action.action_type : `${action.action_type}候選`;
  return `${actionText}：${issueText}${clean}`;
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
  const action = classifyAction(text);
  const notes = [
    "ASR + 規則 label 初稿，需人工校對逐字稿、發言者、議題與是否納入。",
    issue.issue_hits ? `議題命中：${issue.issue_hits}` : "",
    action.action_cues ? `行動線索：${action.action_cues}` : "",
    action.non_action_cues ? `非行動線索：${action.non_action_cues}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    queue_item_id: `asr-review-${String(index + 1).padStart(3, "0")}`,
    action_id: "",
    chunk_id: `${chunk.job_id}-chunk-${String(index + 1).padStart(3, "0")}`,
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
    suggested_primary_issue_label: issue.issue_label || "未分類",
    suggested_issue_confidence: issue.issue_confidence,
    suggested_evidence_role: action.evidence_role,
    suggested_include_status: action.include_status,
    suggested_action_type: action.action_type,
    suggested_summary: makeIntent({ issue, action, text }),
    suggested_notes: notes,
    evidence_frame: "",
    asr_text: text,
    segment_ids: chunk.segment_ids,
    review_status: "needs_review",
  };
}

const segments = parseCsv(await readFile(segmentsPath, "utf8"));
const chunks = chunkSegments(segments);
const items = chunks.map(itemFromChunk);
const first = items[0] || {};

const queue = {
  queue_id: `asr-${first.video_id || "unknown"}-${Math.floor(first.start_seconds || 0)}-${Math.ceil(first.end_seconds || 0)}`,
  title: `ASR 初步標註：${first.video_id || "未知影片"}`,
  description: "由 ASR segments 自動合併並以規則初步 labeling，請人工確認是否為質詢行動。",
  source_video_id: first.video_id || "",
  council_date: "",
  generated_at: new Date().toISOString(),
  labeling_method: "keyword-rules-v1",
  items,
};

await mkdir(new URL(`../../${outputPath.split("/").slice(0, -1).join("/")}/`, import.meta.url), {
  recursive: true,
});
await writeFile(new URL(`../../${outputPath}`, import.meta.url), `${JSON.stringify(queue, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      segments_path: segmentsPath,
      output_path: outputPath,
      input_segments: segments.length,
      output_items: items.length,
      queue_id: queue.queue_id,
    },
    null,
    2
  )
);
