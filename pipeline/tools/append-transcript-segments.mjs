#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGET_PATH = fileURLToPath(new URL("../data/transcript_segments.csv", import.meta.url));
const [, , sourcePath, targetPath = DEFAULT_TARGET_PATH] = process.argv;

if (!sourcePath) {
  console.error("Usage: node pipeline/tools/append-transcript-segments.mjs <source.csv> [target.csv]");
  process.exit(1);
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

const target = parseCsv(await readFile(targetPath, "utf8"));
const source = parseCsv(await readFile(sourcePath, "utf8"));

if (target.headers.join("\n") !== source.headers.join("\n")) {
  console.error(
    JSON.stringify(
      {
        error: "CSV headers do not match",
        source_headers: source.headers,
        target_headers: target.headers,
      },
      null,
      2
    )
  );
  process.exit(1);
}

const existingIds = new Set(target.rows.map((row) => row.segment_id));
const newRows = source.rows.filter((row) => row.segment_id && !existingIds.has(row.segment_id));
const rows = [...target.rows, ...newRows];

await writeFile(targetPath, writeCsv(target.headers, rows), "utf8");

console.log(
  JSON.stringify(
    {
      source_path: sourcePath,
      target_path: targetPath,
      source_rows: source.rows.length,
      appended_rows: newRows.length,
      total_rows: rows.length,
    },
    null,
    2
  )
);
