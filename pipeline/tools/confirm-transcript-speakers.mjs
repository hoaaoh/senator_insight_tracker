#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const CHUNKS_PATH = new URL("../data/transcript_chunks.csv", import.meta.url);
const CANDIDATES_PATH = new URL("../data/action_candidates_from_transcripts.csv", import.meta.url);

const CONFIRMATIONS = {
  "transcript-job-ntpc-1150402-012932-013932-chunk-001": {
    representative_id: "li_qianping",
    representative_name: "李倩萍",
    speaker_confidence: "visual_manual_confirmed",
    note: "畫面 frame-0002 顯示議員李倩萍；目前不在板橋第5選區現任議員 heatmap 範圍",
  },
  "transcript-job-ntpc-1150402-012932-013932-chunk-002": {
    representative_id: "li_qianping",
    representative_name: "李倩萍",
    speaker_confidence: "visual_manual_confirmed",
    note: "畫面 frame-0114 顯示議員李倩萍，投影片對應兒童節禮品預算建議；目前不在板橋第5選區現任議員 heatmap 範圍",
  },
  "transcript-job-ntpc-1150402-012932-013932-chunk-005": {
    representative_id: "yamada_mai",
    representative_name: "山田摩衣",
    speaker_confidence: "visual_manual_confirmed",
    note: "畫面 frame-0456 顯示議員山田摩衣，內容同時涉及板橋醫療園區、長照住宿機構與停車場補助",
  },
  "transcript-job-ntpc-1150402-012932-013932-chunk-006": {
    representative_id: "yamada_mai",
    representative_name: "山田摩衣",
    speaker_confidence: "visual_manual_confirmed",
    note: "畫面 frame-0615 顯示議員山田摩衣，延續板橋醫療園區停車場工程費與停車費收益質詢",
  },
  "transcript-job-ntpc-1150402-012932-013932-chunk-007": {
    representative_id: "yamada_mai",
    representative_name: "山田摩衣",
    speaker_confidence: "visual_manual_confirmed",
    note: "畫面 frame-0730 顯示議員山田摩衣，延續板橋醫療園區停車場補助與收益歸屬質詢",
  },
  "transcript-job-ntpc-1150402-012932-013932-chunk-008": {
    representative_id: "yamada_mai",
    representative_name: "山田摩衣",
    speaker_confidence: "visual_manual_confirmed",
    note: "畫面 frame-0845 顯示議員山田摩衣，延續板橋醫療園區停車場補助與停管基金討論",
  },
  "transcript-job-ntpc-1150402-012932-013932-chunk-009": {
    representative_id: "yamada_mai",
    representative_name: "山田摩衣",
    speaker_confidence: "visual_manual_confirmed",
    note: "前後影格顯示仍為山田摩衣質詢段落，內容接續詢問可行性評估報告",
  },
  "transcript-job-ntpc-1150402-013932-014932-chunk-010": {
    representative_id: "yamada_mai",
    representative_name: "山田摩衣",
    speaker_confidence: "visual_manual_confirmed",
    note: "畫面 frame-0002 顯示議員山田摩衣，延續板橋醫療園區停車場補助、可行性評估與停車位公益性質詢",
  },
  "transcript-job-ntpc-1150402-013932-014932-chunk-011": {
    representative_id: "yamada_mai",
    representative_name: "山田摩衣",
    speaker_confidence: "visual_manual_confirmed",
    note: "畫面 frame-0130 顯示議員山田摩衣，延續可行性評估財務分析與停車場營運收益質詢",
  },
};

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
  if (!headers) return { headers: [], rows: [] };
  return {
    headers,
    rows: records.map((record) =>
      Object.fromEntries(headers.map((header, index) => [header, record[index] || ""]))
    ),
  };
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

function appendNote(existing, note) {
  if (!note) return existing;
  if (!existing) return note;
  if (existing.includes(note)) return existing;
  return `${existing}；${note}`;
}

function updateChunks(rows) {
  let updated = 0;
  for (const row of rows) {
    const confirmation = CONFIRMATIONS[row.chunk_id];
    if (!confirmation) continue;
    row.speaker_candidate = confirmation.representative_name;
    row.speaker_confidence = confirmation.speaker_confidence;
    row.review_status = "speaker_confirmed";
    row.notes = appendNote(row.notes, confirmation.note);
    updated += 1;
  }
  return updated;
}

function updateCandidates(rows) {
  let updated = 0;
  for (const row of rows) {
    const confirmation = CONFIRMATIONS[row.chunk_id];
    if (!confirmation) continue;
    row.representative_id = confirmation.representative_id;
    row.representative_name = confirmation.representative_name;
    row.speaker_confidence = confirmation.speaker_confidence;
    row.review_status = "speaker_confirmed";
    row.notes = appendNote(row.notes, confirmation.note);
    updated += 1;
  }
  return updated;
}

const chunks = parseCsv(await readFile(CHUNKS_PATH, "utf8"));
const candidates = parseCsv(await readFile(CANDIDATES_PATH, "utf8"));

const updatedChunks = updateChunks(chunks.rows);
const updatedCandidates = updateCandidates(candidates.rows);

await writeFile(CHUNKS_PATH, writeCsv(chunks.headers, chunks.rows), "utf8");
await writeFile(CANDIDATES_PATH, writeCsv(candidates.headers, candidates.rows), "utf8");

console.log(
  JSON.stringify(
    {
      updated_chunks: updatedChunks,
      updated_candidates: updatedCandidates,
      chunk_path: CHUNKS_PATH.pathname,
      candidate_path: CANDIDATES_PATH.pathname,
    },
    null,
    2
  )
);
