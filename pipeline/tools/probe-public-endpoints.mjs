#!/usr/bin/env node

const DEFAULT_URLS = [
  "https://bms.ntp.gov.tw/NewTCAV/",
  "https://bms.ntp.gov.tw/NewTCAV/BillQuery/",
  "https://bms.ntp.gov.tw/NewTCAV/BillQuery/BillQuery.aspx",
  "https://bms.ntp.gov.tw/NewTCAV/BillQuery/BillQuery_Form.aspx",
  "https://bms.ntp.gov.tw/NewTCAV/BillQuery/BillQuery_Form_Query.aspx",
  "https://bms.ntp.gov.tw/NewTCAV/BillQuery/BillQuery_Form_List.aspx",
  "https://bms.ntp.gov.tw/NewTCAV/BillQuery/BillQuery_List.aspx",
  "https://bms.ntp.gov.tw/NewTCAV/BillQuery/BillQuery_Form_Context.aspx?BillNO=34715",
  "https://bms.ntp.gov.tw/NewTCAV/MeetQuery/",
  "https://bms.ntp.gov.tw/NewTCAV/MeetingQuery/",
  "https://ivod.ntp.gov.tw/",
  "https://vod.ntp.gov.tw/",
  "https://video.ntp.gov.tw/",
  "https://meeting.ntp.gov.tw/",
  "https://agenda.ntp.gov.tw/",
  "https://mis.ntp.gov.tw/",
  "https://tccmis.ntp.gov.tw/",
  "https://www.ntp.gov.tw/",
];

const urls = process.argv.slice(2);
const targets = urls.length ? urls : DEFAULT_URLS;

function textBetween(text, open, close) {
  const start = text.toLowerCase().indexOf(open.toLowerCase());
  if (start < 0) return "";
  const valueStart = start + open.length;
  const end = text.toLowerCase().indexOf(close.toLowerCase(), valueStart);
  if (end < 0) return "";
  return text.slice(valueStart, end).replace(/\s+/g, " ").trim();
}

async function probe(url) {
  const startedAt = Date.now();
  const result = {
    url,
    ok: false,
    status: "",
    finalUrl: "",
    contentType: "",
    bytes: 0,
    title: "",
    hint: "",
    elapsedMs: 0,
  };

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(12000),
    });
    const text = await response.text();
    result.ok = response.ok;
    result.status = String(response.status);
    result.finalUrl = response.url;
    result.contentType = response.headers.get("content-type") || "";
    result.bytes = Buffer.byteLength(text);
    result.title = textBetween(text, "<title>", "</title>");
    result.hint = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  } catch (error) {
    result.status = "ERROR";
    result.hint = error.message;
  } finally {
    result.elapsedMs = Date.now() - startedAt;
  }

  return result;
}

const results = [];
for (const target of targets) {
  results.push(await probe(target));
}

console.log(
  [
    "status",
    "ok",
    "bytes",
    "elapsed_ms",
    "title",
    "url",
    "final_url",
    "hint",
  ].join("\t")
);

for (const item of results) {
  console.log(
    [
      item.status,
      item.ok ? "yes" : "no",
      item.bytes,
      item.elapsedMs,
      item.title,
      item.url,
      item.finalUrl,
      item.hint,
    ]
      .map((value) => String(value).replace(/\t/g, " ").replace(/\n/g, " "))
      .join("\t")
  );
}
