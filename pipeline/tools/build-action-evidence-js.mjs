import { mkdir, readFile, writeFile } from "node:fs/promises";

const inputPath = new URL("../data/action_evidence_from_transcripts.csv", import.meta.url);
const outputPath = new URL("../data/exports/actionEvidence.js", import.meta.url);

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  values.push(value);
  return values;
}

function parseCsv(csv) {
  const lines = csv
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length);

  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

const csv = await readFile(inputPath, "utf8");
const rows = parseCsv(csv);
const output = `window.MVP_ACTION_EVIDENCE = ${JSON.stringify(rows, null, 2)};\n`;

await mkdir(new URL("../data/exports/", import.meta.url), { recursive: true });
await writeFile(outputPath, output, "utf8");
console.log(`Wrote ${rows.length} evidence rows to ${outputPath.pathname}`);
