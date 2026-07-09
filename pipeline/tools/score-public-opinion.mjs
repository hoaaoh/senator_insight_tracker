#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const SOURCES_PATH = new URL("../data/public_opinion_sources.csv", import.meta.url);
const SCORES_PATH = new URL("../data/public_opinion_monthly_scores.csv", import.meta.url);

const SOURCE_WEIGHTS = {
  news: 0.4,
  search: 0.3,
  social: 0.2,
  forum: 0.1,
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

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function confidence(sourceTypes, checked, passed) {
  const rate = checked > 0 ? passed / checked : 0;
  if (sourceTypes.size >= 3 && rate >= 0.75) return "high";
  if (sourceTypes.size >= 2 || rate >= 0.6) return "medium";
  return "low";
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

const sources = parseCsv(await readFile(SOURCES_PATH, "utf8")).filter(
  (row) => row.month && row.issue_id && row.source_type
);

const groups = new Map();
for (const row of sources) {
  const key = `${row.month}::${row.issue_id}`;
  if (!groups.has(key)) {
    groups.set(key, {
      month: row.month,
      issue_id: row.issue_id,
      issue_label: row.issue_label,
      byType: new Map(),
      sourceTypes: new Set(),
      checked: 0,
      passed: 0,
      sourceCount: 0,
    });
  }

  const group = groups.get(key);
  const type = row.source_type;
  const score = clampScore(toNumber(row.normalized_score));
  group.sourceTypes.add(type);
  group.sourceCount += 1;
  group.checked += toNumber(row.relevance_checked_count);
  group.passed += toNumber(row.relevance_pass_count);

  if (!group.byType.has(type)) group.byType.set(type, []);
  group.byType.get(type).push(score);
}

const rows = [...groups.values()]
  .sort((a, b) => a.month.localeCompare(b.month) || a.issue_id.localeCompare(b.issue_id))
  .map((group) => {
    const typeScores = {};
    for (const type of Object.keys(SOURCE_WEIGHTS)) {
      const scores = group.byType.get(type) || [];
      typeScores[type] = scores.length
        ? scores.reduce((sum, score) => sum + score, 0) / scores.length
        : 0;
    }

    let weightedSum = 0;
    let weightSum = 0;
    for (const [type, weight] of Object.entries(SOURCE_WEIGHTS)) {
      if (group.byType.has(type)) {
        weightedSum += typeScores[type] * weight;
        weightSum += weight;
      }
    }

    const finalHeatScore = weightSum ? clampScore(weightedSum / weightSum) : 0;
    return {
      month: group.month,
      issue_id: group.issue_id,
      issue_label: group.issue_label,
      news_score: clampScore(typeScores.news),
      search_score: clampScore(typeScores.search),
      social_score: clampScore(typeScores.social),
      forum_score: clampScore(typeScores.forum),
      final_heat_score: finalHeatScore,
      confidence: confidence(group.sourceTypes, group.checked, group.passed),
      source_count: group.sourceCount,
      relevance_checked_count: group.checked,
      relevance_pass_count: group.passed,
      review_status: group.checked > 0 ? "needs_review" : "unreviewed",
      notes: `source_types=${[...group.sourceTypes].sort().join("|")}`,
    };
  });

const headers = [
  "month",
  "issue_id",
  "issue_label",
  "news_score",
  "search_score",
  "social_score",
  "forum_score",
  "final_heat_score",
  "confidence",
  "source_count",
  "relevance_checked_count",
  "relevance_pass_count",
  "review_status",
  "notes",
];

await writeFile(SCORES_PATH, writeCsv(headers, rows), "utf8");

console.log(
  JSON.stringify(
    {
      input_sources: sources.length,
      output_scores: rows.length,
      output_path: SCORES_PATH.pathname,
    },
    null,
    2
  )
);
