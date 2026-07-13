#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ASR_QUEUE = "pipeline/data/asr_queue/ntpc_council_high_20260501_20260630_1800s.json";
const DEFAULT_QUEUE_MANIFEST = "viewer/reviewer/queue_manifest.json";
const DEFAULT_DECISIONS_PATH = "viewer/reviewer/video_review_decisions.json";
const DEFAULT_OUTPUT = "viewer/reviewer/video_manifest.json";

const args = parseArgs(process.argv.slice(2));
const asrQueuePath = args.asrQueue || DEFAULT_ASR_QUEUE;
const queueManifestPath = args.queueManifest || DEFAULT_QUEUE_MANIFEST;
const decisionsPath = args.decisions || DEFAULT_DECISIONS_PATH;
const outputPath = args.output || DEFAULT_OUTPUT;

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    const [key, value = ""] = arg.split("=");
    if (key === "--asr-queue") parsed.asrQueue = value;
    if (key === "--queue-manifest") parsed.queueManifest = value;
    if (key === "--decisions") parsed.decisions = value;
    if (key === "--output") parsed.output = value;
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
node pipeline/tools/build-review-video-manifest.mjs [options]

Options:
  --asr-queue=<path>          ASR job queue JSON, usually a month batch.
  --queue-manifest=<path>     Existing reviewer queue manifest.
  --decisions=<path>          Video-level ASR queue/exclusion decisions.
  --output=<path>             Public reviewer video manifest output.
`);
}

function rocYear(date) {
  if (!date) return "";
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? String(year - 1911) : "";
}

function formatHours(seconds) {
  return Number((seconds / 3600).toFixed(2));
}

function progressStatusFromJobs(jobs) {
  const total = jobs.length;
  const withSegments = jobs.filter((job) => job.segments_status === "ready").length;
  const withTranscript = jobs.filter((job) => job.transcript_status === "transcript_draft_ready").length;
  if (total && withSegments >= total) return "segments_ready";
  if (withSegments || withTranscript) return "asr_in_progress";
  return "asr_waiting";
}

function targetNotes(status, matchedQueue) {
  if (matchedQueue) return "已有 reviewer queue，可直接進入人工校正。";
  if (status === "segments_ready") {
    return "ASR segments 已完成；下一步需判斷是否有有效質詢，若有再切成議員與議題小題目。";
  }
  if (status === "asr_in_progress") {
    return "已有部分 ASR 產出；需跑完剩餘 job 後再切成校正題目。";
  }
  return "已列入五月到六月 ASR 批次；跑完 ASR 並產生單支影片 queue 後即可校正。";
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

function queueEntryKey(entry) {
  return `${entry.video_id || ""}:${entry.date || ""}`;
}

function makeAsrTargets(asrQueue, queueManifest, decisionByVideo) {
  const queueByVideoAndDate = new Map(
    (queueManifest.queues || []).map((entry) => [queueEntryKey(entry), entry])
  );

  return Array.from(groupJobsByVideo(asrQueue.jobs || []).values()).map((jobs) => {
    const first = jobs[0];
    const endSeconds = Math.max(...jobs.map((job) => Number(job.end_seconds) || 0));
    const queuedSeconds = jobs.reduce((sum, job) => sum + (Number(job.duration_seconds) || 0), 0);
    const matchedQueue = queueByVideoAndDate.get(`${first.video_id || ""}:${first.council_date || ""}`);
    const decision = decisionByVideo.get(first.video_id);
    const status = decision?.status_hint === "queue_ready" ? "ready" : decision?.status_hint || (matchedQueue ? "ready" : progressStatusFromJobs(jobs));

    return {
      target_id: first.source_id,
      source_id: first.source_id,
      video_id: first.video_id,
      title: first.title,
      date: first.council_date,
      roc_year: first.council_date_roc?.slice(0, 3) || rocYear(first.council_date),
      meeting_type: first.meeting_type,
      councilor_id: matchedQueue?.councilor_id || "",
      councilor_name: matchedQueue?.councilor_name || "待辨識",
      issue_ids: matchedQueue?.issue_ids || [],
      issue_labels: matchedQueue?.issue_labels || ["待分類"],
      queue_id: decision?.queue_id || matchedQueue?.queue_id || "",
      queue_path: decision?.queue_path || matchedQueue?.path || "",
      item_count: decision?.item_count || matchedQueue?.item_count || 0,
      status_label: decision?.status_label || "",
      is_partial: Boolean(decision?.status_label?.includes("部分")),
      job_count: jobs.length,
      duration_seconds: endSeconds,
      queued_hours: formatHours(queuedSeconds),
      status_hint: status,
      watch_url: first.watch_url,
      notes: decision?.decision_reason || targetNotes(status, matchedQueue),
    };
  });
}

function makeQueueOnlyTargets(queueManifest, existingTargetKeys) {
  return (queueManifest.queues || [])
    .filter((entry) => !existingTargetKeys.has(queueEntryKey(entry)))
    .map((entry) => ({
      target_id: entry.queue_id,
      source_id: "",
      video_id: entry.video_id || "",
      title: entry.title,
      date: entry.date || "",
      roc_year: entry.roc_year || rocYear(entry.date),
      meeting_type: entry.meeting_type || "review_queue",
      councilor_id: entry.councilor_id || "",
      councilor_name: entry.councilor_name || "待辨識",
      issue_ids: entry.issue_ids || [],
      issue_labels: entry.issue_labels || ["待分類"],
      queue_id: entry.queue_id,
      queue_path: entry.path,
      item_count: entry.item_count || 0,
      job_count: 0,
      duration_seconds: 0,
      queued_hours: 0,
      status_hint: entry.status_hint === "demo" ? "ready" : entry.status_hint || "ready",
      watch_url: entry.video_id ? `https://www.youtube.com/watch?v=${entry.video_id}` : "",
      notes: "既有 reviewer queue，可直接校正並匯出單一 JSON。",
    }));
}

const asrQueue = JSON.parse(await readFile(asrQueuePath, "utf8"));
const queueManifest = JSON.parse(await readFile(queueManifestPath, "utf8"));
let decisions = { decisions: [] };
try {
  decisions = JSON.parse(await readFile(decisionsPath, "utf8"));
} catch {
  decisions = { decisions: [] };
}
const decisionByVideo = new Map((decisions.decisions || []).map((decision) => [decision.video_id, decision]));
const asrTargets = makeAsrTargets(asrQueue, queueManifest, decisionByVideo);
const existingTargetKeys = new Set(asrTargets.map((target) => `${target.video_id || ""}:${target.date || ""}`));
const targets = [...asrTargets, ...makeQueueOnlyTargets(queueManifest, existingTargetKeys)].sort((a, b) => {
  const dateSort = String(b.date || "").localeCompare(String(a.date || ""));
  if (dateSort) return dateSort;
  return String(a.title || "").localeCompare(String(b.title || ""), "zh-Hant");
});

const payload = {
  version: 1,
  generated_at: new Date().toISOString(),
  source_asr_queue: asrQueuePath,
  summary: {
    total_targets: targets.length,
    ready_targets: targets.filter((target) => target.queue_path).length,
    segments_ready_targets: targets.filter((target) => target.status_hint === "segments_ready").length,
    asr_in_progress_targets: targets.filter((target) => target.status_hint === "asr_in_progress").length,
    asr_waiting_targets: targets.filter((target) => target.status_hint === "asr_waiting").length,
    excluded_targets: targets.filter((target) => target.status_hint === "excluded").length,
    asr_batch: asrQueue.summary || {},
  },
  targets,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      output_path: outputPath,
      total_targets: payload.summary.total_targets,
      ready_targets: payload.summary.ready_targets,
      segments_ready_targets: payload.summary.segments_ready_targets,
      excluded_targets: payload.summary.excluded_targets,
      asr_waiting_targets: payload.summary.asr_waiting_targets,
    },
    null,
    2
  )
);
