import { mkdir, readFile, writeFile } from "node:fs/promises";

const evidencePath = new URL("../data/action_evidence_from_transcripts.csv", import.meta.url);
const segmentsPath = new URL("../data/transcript_segments.csv", import.meta.url);
const outputPath = new URL("../../viewer/reviewer/review_queue.json", import.meta.url);

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

function textForRange(segments, start, end) {
  return segments
    .filter((segment) => {
      const segmentStart = Number(segment.start_seconds);
      const segmentEnd = Number(segment.end_seconds);
      return segmentStart < end && segmentEnd > start;
    })
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function getVideoId(sourceUrl, fallback = "") {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.split("/").filter(Boolean)[0] || fallback;
    }
    return url.searchParams.get("v") || fallback;
  } catch {
    return fallback;
  }
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

const evidenceRows = parseCsv(await readFile(evidencePath, "utf8"));
const segments = parseCsv(await readFile(segmentsPath, "utf8"));

const items = evidenceRows.map((row, index) => {
  const start = Number(row.start_seconds);
  const end = Number(row.end_seconds);
  const videoId = getVideoId(row.source_url, "LYxQ5yS4Xrg");
  return {
    queue_item_id: `review-${String(index + 1).padStart(3, "0")}`,
    action_id: row.action_id,
    chunk_id: row.chunk_id,
    source_id: row.source_id,
    source_url: row.source_url,
    video_id: videoId,
    watch_url: watchUrl(videoId, start),
    embed_url: embedUrl(videoId, start, end),
    start_seconds: start,
    end_seconds: end,
    representative_id: row.representative_id,
    representative_name: row.representative_name,
    suggested_primary_issue: row.issue_id,
    suggested_primary_issue_label: row.issue_label,
    suggested_evidence_role: row.evidence_role,
    suggested_summary: row.evidence_summary,
    suggested_notes: row.notes,
    evidence_frame: row.evidence_frame ? `../${row.evidence_frame}` : "",
    asr_text: textForRange(segments, start, end),
    review_status: "needs_review",
  };
});

const queue = {
  queue_id: "ntpc-2026-04-02-yamada-mai-transport-demo",
  title: "2026-04-02 山田摩衣：板橋醫療園區停車場補助與收益質詢",
  description:
    "Demo review queue：請校正 ASR 文字、確認發言者、議題分類、行動意圖與 evidence role。",
  source_video_id: "LYxQ5yS4Xrg",
  council_date: "2026-04-02",
  generated_at: new Date().toISOString(),
  items,
};

await mkdir(new URL("../../viewer/reviewer/", import.meta.url), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(queue, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      output_path: outputPath.pathname,
      queue_id: queue.queue_id,
      item_count: items.length,
    },
    null,
    2
  )
);
