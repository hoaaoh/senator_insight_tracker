import { writeFile } from "node:fs/promises";

const [fromArg, toArg] = process.argv.slice(2);
const from = Number(fromArg || 10095);
const to = Number(toArg || from);
const endpoint =
  "https://bms.ntp.gov.tw/NewTCAV/BillQuery/BillQuery_Form_Context.aspx?BillNO=";

function textBetween(html, id) {
  const pattern = new RegExp(`id="${id}">([\\s\\S]*?)<\\/span>`);
  const match = html.match(pattern);
  return match ? cleanHtml(match[1]) : "";
}

function cleanHtml(value) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function rocDateToIso(value) {
  if (!/^\d{7}$/.test(value)) return "";
  const year = Number(value.slice(0, 3)) + 1911;
  return `${year}-${value.slice(3, 5)}-${value.slice(5, 7)}`;
}

function toCsvValue(value) {
  const stringValue = String(value ?? "");
  if (!/[",\n]/.test(stringValue)) return stringValue;
  return `"${stringValue.replaceAll('"', '""')}"`;
}

const rows = [];

for (let billNo = from; billNo <= to; billNo += 1) {
  const response = await fetch(`${endpoint}${billNo}`);
  const html = await response.text();
  const comeDate = textBetween(html, "lab_ComeDate");
  const reason = textBetween(html, "lab_Reason");

  if (!comeDate && !reason) continue;

  rows.push({
    bill_no: billNo,
    source_url: `${endpoint}${billNo}`,
    bill_type: textBetween(html, "lab_BillType"),
    bill_class: textBetween(html, "lab_BillClass"),
    provider: textBetween(html, "lab_Provider"),
    support_man: textBetween(html, "lab_SupportMan"),
    roc_date: comeDate,
    action_date: rocDateToIso(comeDate),
    reason,
    description: textBetween(html, "lab_Description"),
    method: textBetween(html, "lab_Method")
  });
}

const headers = [
  "bill_no",
  "source_url",
  "bill_type",
  "bill_class",
  "provider",
  "support_man",
  "roc_date",
  "action_date",
  "reason",
  "description",
  "method"
];
const csv = [
  headers.join(","),
  ...rows.map((row) => headers.map((header) => toCsvValue(row[header])).join(","))
].join("\n");
const outputPath = new URL(`../data/bms_bills_${from}_${to}.csv`, import.meta.url);

await writeFile(outputPath, `${csv}\n`, "utf8");
console.log(`Wrote ${rows.length} bills to ${outputPath.pathname}`);
