#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const SEGMENTS_PATH = new URL("../data/transcript_segments.csv", import.meta.url);
const SOURCES_PATH = new URL("../data/council_video_sources.csv", import.meta.url);
const CHUNKS_PATH = new URL("../data/transcript_chunks.csv", import.meta.url);
const CANDIDATES_PATH = new URL("../data/action_candidates_from_transcripts.csv", import.meta.url);

const ISSUES = [
  {
    id: "housing",
    label: "居住都更",
    keywords: ["社宅", "租屋", "都更", "危老", "居住", "住宅", "違規隔間", "房租"],
  },
  {
    id: "transport",
    label: "交通行人",
    keywords: ["交通", "公車", "停車", "捷運", "YouBike", "行人", "路口", "通勤", "車流"],
  },
  {
    id: "energy",
    label: "市場商圈",
    keywords: ["市場", "商圈", "夜市", "攤商", "店家", "府中", "黃石", "湳雅"],
  },
  {
    id: "labor",
    label: "地方建設",
    keywords: ["工程", "公園", "道路", "排水", "活動中心", "建設", "修繕", "里", "預算"],
  },
  {
    id: "care",
    label: "長照社福",
    keywords: ["長照", "社福", "弱勢", "身障", "老人", "照顧", "關懷", "福利"],
  },
  {
    id: "education",
    label: "托育教育",
    keywords: ["學校", "各校", "家長會", "孩子", "學生", "教育", "教育局", "校園", "文具", "圖書", "兒童", "採購", "經費"],
  },
  {
    id: "justice",
    label: "治安詐騙",
    keywords: ["詐騙", "治安", "警力", "監視器", "毒品", "警察", "犯罪"],
  },
];

const ACTION_CUES = [
  "建議",
  "要求",
  "希望",
  "請",
  "主管機關",
  "怎麼樣去避免",
  "可不可以",
  "增加預算",
  "改發",
  "善用",
  "不要讓",
  "彈性",
  "提出",
  "改善",
  "處理",
];

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

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function writeCsv(headers, rows) {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(",")),
  ].join("\n") + "\n";
}

function getSourceMap(sources) {
  return Object.fromEntries(sources.map((source) => [source.source_id, source]));
}

function classifyIssue(text) {
  const scores = ISSUES.map((issue) => {
    const hits = issue.keywords.filter((keyword) => text.includes(keyword));
    return { ...issue, score: hits.length, hits };
  }).sort((a, b) => b.score - a.score);

  const best = scores[0];
  if (!best || best.score === 0) {
    return { issue_id: "", issue_label: "", issue_score: 0, issue_hits: "" };
  }

  return {
    issue_id: best.id,
    issue_label: best.label,
    issue_score: best.score,
    issue_hits: best.hits.join("|"),
  };
}

function scoreActionCues(text) {
  const hits = ACTION_CUES.filter((cue) => text.includes(cue));
  return { action_cue_score: hits.length, action_cues: hits.join("|") };
}

function youtubeUrl(videoId, startSeconds) {
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(startSeconds))}s`;
}

function chunkSegments(segments, sourceMap) {
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
      segment.end - active.start_seconds > 75;

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

  return chunks.map((chunk, index) => {
    const text = chunk.texts.join(" ").replace(/\s+/g, " ").trim();
    const source = sourceMap[chunk.source_id] || {};
    const issue = classifyIssue(text);
    const action = scoreActionCues(text);
    return {
      chunk_id: `${chunk.job_id}-chunk-${String(index + 1).padStart(3, "0")}`,
      job_id: chunk.job_id,
      source_id: chunk.source_id,
      video_id: chunk.video_id,
      council_date: source.council_date || "",
      start_seconds: chunk.start_seconds.toFixed(2),
      end_seconds: chunk.end_seconds.toFixed(2),
      duration_seconds: (chunk.end_seconds - chunk.start_seconds).toFixed(2),
      youtube_url: youtubeUrl(chunk.video_id, chunk.start_seconds),
      segment_count: chunk.segment_ids.length,
      segment_ids: chunk.segment_ids.join("|"),
      speaker_candidate: "",
      speaker_confidence: "unknown",
      text,
      ...issue,
      ...action,
      review_status: "needs_review",
      notes: "自動合併與規則分類初稿，需人工確認發言者、議題與逐字稿錯字",
    };
  });
}

function makeCandidates(chunks) {
  return chunks
    .filter((chunk) => Number(chunk.issue_score) >= 2 && Number(chunk.action_cue_score) >= 2)
    .map((chunk, index) => {
      const date = chunk.council_date || "";
      const month = date ? date.slice(0, 7) : "";
      const weight = Math.min(4, Math.max(2, Math.ceil(Number(chunk.action_cue_score) / 2)));
      const title = chunk.issue_label
        ? `議會質詢候選：${chunk.issue_label}相關要求`
        : "議會質詢候選";
      return {
        candidate_action_id: `candidate-${chunk.chunk_id}`,
        chunk_id: chunk.chunk_id,
        source_id: chunk.source_id,
        source_name: "新北市議會 YouTube 議事影音 ASR 初稿",
        source_url: chunk.youtube_url,
        action_date: date,
        action_month: month,
        representative_id: "",
        representative_name: "",
        speaker_confidence: "unknown",
        issue_id: chunk.issue_id,
        issue_label: chunk.issue_label,
        action_type: "質詢候選",
        title,
        summary: chunk.text.slice(0, 180),
        evidence_text: chunk.text,
        suggested_weight: weight,
        action_cues: chunk.action_cues,
        issue_hits: chunk.issue_hits,
        review_status: "needs_speaker_review",
        notes: `候選序號 ${index + 1}；需先確認發言議員與 ASR 文字後才可轉正式 action`,
      };
    });
}

const [segmentsText, sourcesText] = await Promise.all([
  readFile(SEGMENTS_PATH, "utf8"),
  readFile(SOURCES_PATH, "utf8"),
]);

const segments = parseCsv(segmentsText);
const sources = parseCsv(sourcesText);
const chunks = chunkSegments(segments, getSourceMap(sources));
const candidates = makeCandidates(chunks);

const chunkHeaders = [
  "chunk_id",
  "job_id",
  "source_id",
  "video_id",
  "council_date",
  "start_seconds",
  "end_seconds",
  "duration_seconds",
  "youtube_url",
  "segment_count",
  "segment_ids",
  "speaker_candidate",
  "speaker_confidence",
  "text",
  "issue_id",
  "issue_label",
  "issue_score",
  "issue_hits",
  "action_cue_score",
  "action_cues",
  "review_status",
  "notes",
];

const candidateHeaders = [
  "candidate_action_id",
  "chunk_id",
  "source_id",
  "source_name",
  "source_url",
  "action_date",
  "action_month",
  "representative_id",
  "representative_name",
  "speaker_confidence",
  "issue_id",
  "issue_label",
  "action_type",
  "title",
  "summary",
  "evidence_text",
  "suggested_weight",
  "action_cues",
  "issue_hits",
  "review_status",
  "notes",
];

await Promise.all([
  writeFile(CHUNKS_PATH, writeCsv(chunkHeaders, chunks), "utf8"),
  writeFile(CANDIDATES_PATH, writeCsv(candidateHeaders, candidates), "utf8"),
]);

console.log(
  JSON.stringify(
    {
      input_segments: segments.length,
      output_chunks: chunks.length,
      output_candidates: candidates.length,
      chunks_path: CHUNKS_PATH.pathname,
      candidates_path: CANDIDATES_PATH.pathname,
    },
    null,
    2
  )
);
