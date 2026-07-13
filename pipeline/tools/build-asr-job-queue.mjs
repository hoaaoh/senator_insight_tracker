#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_VIDEO_INDEX = "pipeline/data/video_index/ntpc_council_youtube_streams.json";
const DEFAULT_OUTPUT_DIR = "pipeline/data/asr_queue";
const DEFAULT_PRIORITY = "high";
const DEFAULT_SEGMENT_SECONDS = 30 * 60;
const DEFAULT_MODEL = "small";

const args = parseArgs(process.argv.slice(2));
const videoIndexPath = args.videoIndex || DEFAULT_VIDEO_INDEX;
const outputDir = args.outputDir || DEFAULT_OUTPUT_DIR;
const priority = args.priority || DEFAULT_PRIORITY;
const segmentSeconds = args.segmentSeconds || DEFAULT_SEGMENT_SECONDS;
const maxVideos = args.maxVideos || 0;
const model = args.model || DEFAULT_MODEL;
const dateFrom = args.dateFrom || "";
const dateTo = args.dateTo || "";

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    const [key, value = ""] = arg.split("=");
    if (key === "--video-index") parsed.videoIndex = value;
    if (key === "--output-dir") parsed.outputDir = value;
    if (key === "--priority") parsed.priority = value;
    if (key === "--segment-seconds") parsed.segmentSeconds = Number(value);
    if (key === "--max-videos") parsed.maxVideos = Number(value);
    if (key === "--model") parsed.model = value;
    if (key === "--date-from") parsed.dateFrom = value;
    if (key === "--date-to") parsed.dateTo = value;
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
node pipeline/tools/build-asr-job-queue.mjs [options]

Options:
  --priority=high          Keep videos with this ASR priority. Use all for every archived video.
  --segment-seconds=1800   Split each video into fixed-size ASR jobs.
  --date-from=2026-04-01   Optional Gregorian start date.
  --date-to=2026-04-30     Optional Gregorian end date.
  --max-videos=10          Optional cap for a trial batch.
  --model=small            faster-whisper model label used in output paths.
`);
}

function inDateRange(video) {
  if (dateFrom && video.gregorian_date < dateFrom) return false;
  if (dateTo && video.gregorian_date > dateTo) return false;
  return true;
}

function shouldKeepVideo(video) {
  if (!video.needs_asr || video.status !== "archived") return false;
  if (!video.duration_seconds || video.duration_seconds <= 0) return false;
  if (!inDateRange(video)) return false;
  if (priority !== "all" && video.asr_priority !== priority) return false;
  return true;
}

function sanitizeId(value) {
  return String(value || "")
    .replaceAll("-", "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 80);
}

function sourceId(video) {
  const rocDate = sanitizeId(video.roc_date);
  return `ntpc-council-youtube-${rocDate}-${sanitizeId(video.video_id)}`;
}

function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}

function compactTime(seconds) {
  return formatTime(seconds).replaceAll(":", "");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function segmentVideo(video) {
  const jobs = [];
  const id = sourceId(video);
  for (let start = 0; start < video.duration_seconds; start += segmentSeconds) {
    const end = Math.min(start + segmentSeconds, video.duration_seconds);
    const duration = end - start;
    if (duration <= 0) continue;

    const startLabel = compactTime(start);
    const endLabel = compactTime(end);
    const jobId = `asr-${id}-${startLabel}-${endLabel}`;
    const audioPath = `pipeline/data/raw/${id}-${startLabel}-${endLabel}.m4a`;
    const transcriptPath = `pipeline/data/transcripts/${id}-${startLabel}-${endLabel}.faster-whisper-${model}.json`;
    const segmentsCsvPath = `pipeline/data/transcripts/${id}-${startLabel}-${endLabel}.segments.csv`;

    jobs.push({
      job_id: jobId,
      source_id: id,
      video_id: video.video_id,
      title: video.title,
      council_date: video.gregorian_date,
      council_date_roc: video.roc_date,
      meeting_type: video.meeting_type,
      asr_priority: video.asr_priority,
      start_seconds: start,
      end_seconds: end,
      duration_seconds: duration,
      start_timecode: formatTime(start),
      end_timecode: formatTime(end),
      watch_url: `${video.watch_url}&t=${Math.floor(start)}s`,
      audio_path: audioPath,
      transcript_path: transcriptPath,
      segments_csv_path: segmentsCsvPath,
      transcript_status: "queued",
      review_status: "not_started",
      notes: "由影片索引產生；需先下載音訊，再跑 faster-whisper，最後匯入校正 queue",
      download_command: [
        "node",
        "pipeline/tools/download-youtube-audio-segment.mjs",
        shellQuote(video.watch_url),
        shellQuote(id),
        String(start),
        String(duration),
      ].join(" "),
      transcribe_command: [
        "python3",
        "pipeline/tools/transcribe_faster_whisper.py",
        shellQuote(audioPath),
        shellQuote(transcriptPath),
        "--model",
        model,
        "--device",
        "cpu",
        "--compute-type",
        "int8",
        "--language",
        "zh",
        "--beam-size",
        "5",
        "--job-id",
        shellQuote(jobId),
        "--source-id",
        shellQuote(id),
        "--video-id",
        shellQuote(video.video_id),
        "--global-start",
        String(start),
        "--segments-csv",
        shellQuote(segmentsCsvPath),
      ].join(" "),
      append_segments_command: [
        "node",
        "pipeline/tools/append-transcript-segments.mjs",
        shellQuote(segmentsCsvPath),
      ].join(" "),
    });
  }
  return jobs;
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:=%-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function markExistingOutputs(jobs) {
  for (const job of jobs) {
    const hasAudio = await fileExists(job.audio_path);
    const hasTranscript = await fileExists(job.transcript_path);
    const hasSegmentsCsv = await fileExists(job.segments_csv_path);
    job.audio_status = hasAudio ? "ready" : "missing";
    job.transcript_status = hasTranscript ? "transcript_draft_ready" : "queued";
    job.segments_status = hasSegmentsCsv ? "ready" : "missing";
  }
  return jobs;
}

function summarize(videos, jobs) {
  const byDate = {};
  const byMeetingType = {};
  const totalSeconds = jobs.reduce((sum, job) => sum + job.duration_seconds, 0);
  for (const video of videos) {
    const dateKey = video.gregorian_date.slice(0, 7);
    byDate[dateKey] = (byDate[dateKey] || 0) + 1;
    byMeetingType[video.meeting_type] = (byMeetingType[video.meeting_type] || 0) + 1;
  }
  return {
    selected_videos: videos.length,
    queued_jobs: jobs.length,
    segment_seconds: segmentSeconds,
    estimated_asr_hours: Number((totalSeconds / 3600).toFixed(2)),
    by_month: byDate,
    by_meeting_type: byMeetingType,
  };
}

function toCsv(rows) {
  const columns = [
    "job_id",
    "source_id",
    "video_id",
    "title",
    "council_date",
    "council_date_roc",
    "meeting_type",
    "asr_priority",
    "start_seconds",
    "end_seconds",
    "duration_seconds",
    "start_timecode",
    "end_timecode",
    "watch_url",
    "audio_path",
    "audio_status",
    "transcript_path",
    "transcript_status",
    "segments_csv_path",
    "segments_status",
    "review_status",
    "notes",
  ];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n") + "\n";
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

async function main() {
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) {
    throw new Error("--segment-seconds must be a positive number.");
  }

  const index = JSON.parse(await readFile(videoIndexPath, "utf8"));
  let videos = index.videos.filter(shouldKeepVideo);
  if (maxVideos > 0) videos = videos.slice(0, maxVideos);

  const jobs = await markExistingOutputs(videos.flatMap(segmentVideo));
  const payload = {
    generated_at: new Date().toISOString(),
    source_video_index: videoIndexPath,
    filters: {
      priority,
      date_from: dateFrom,
      date_to: dateTo,
      max_videos: maxVideos || null,
      model,
    },
    summary: summarize(videos, jobs),
    jobs,
  };

  await mkdir(outputDir, { recursive: true });
  const nameParts = ["ntpc_council", priority, dateFrom || "all", dateTo || "all", `${segmentSeconds}s`]
    .map((part) => sanitizeId(part) || "all")
    .join("_");
  const jsonPath = path.join(outputDir, `${nameParts}.json`);
  const csvPath = path.join(outputDir, `${nameParts}.csv`);
  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(csvPath, toCsv(jobs));

  console.log(`Wrote ${jobs.length} ASR jobs from ${videos.length} videos`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
  console.log(JSON.stringify(payload.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
