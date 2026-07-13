#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const DEFAULT_QUEUE = "pipeline/data/asr_queue/ntpc_council_high_20260401_20260430_1800s.json";

const args = parseArgs(process.argv.slice(2));
const queuePath = args.queue || DEFAULT_QUEUE;

function parseArgs(argv) {
  const parsed = { dryRun: false, first: false, force: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--dry-run") parsed.dryRun = true;
    if (arg === "--first") parsed.first = true;
    if (arg === "--force") parsed.force = true;
    const [key, value = ""] = arg.split("=");
    if (key === "--queue") parsed.queue = value;
    if (key === "--job-id") parsed.jobId = value;
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
node pipeline/tools/run-asr-job.mjs --first [--dry-run]
node pipeline/tools/run-asr-job.mjs --job-id=<job_id> [--queue=<path>]

Options:
  --queue=<path>   ASR queue JSON path
  --first          Run the first job without a ready transcript
  --job-id=<id>    Run a specific job
  --dry-run        Print commands without executing
  --force          Re-run even if transcript output already exists
`);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pickJob(queue) {
  if (args.jobId) {
    const job = queue.jobs.find((candidate) => candidate.job_id === args.jobId);
    if (!job) throw new Error(`Could not find job_id: ${args.jobId}`);
    return job;
  }
  if (args.first) {
    const job = queue.jobs.find((candidate) => candidate.transcript_status !== "transcript_draft_ready");
    if (!job) throw new Error("No queued job found.");
    return job;
  }
  printUsage();
  process.exit(1);
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function commandText(command, commandArgs) {
  return [command, ...commandArgs.map(shellQuote)].join(" ");
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:=%-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function maybeRun(label, command, commandArgs) {
  const text = commandText(command, commandArgs);
  console.log(`\n# ${label}`);
  console.log(text);
  if (!args.dryRun) await run(command, commandArgs);
}

async function main() {
  const queue = JSON.parse(await readFile(queuePath, "utf8"));
  const job = pickJob(queue);
  const hasTranscript = await fileExists(job.transcript_path);
  if (hasTranscript && !args.force) {
    console.log(`Transcript already exists: ${job.transcript_path}`);
    console.log("Use --force to re-run this job.");
    return;
  }

  console.log(
    JSON.stringify(
      {
        queue: queuePath,
        job_id: job.job_id,
        video_id: job.video_id,
        title: job.title,
        start_timecode: job.start_timecode,
        end_timecode: job.end_timecode,
        duration_seconds: job.duration_seconds,
        dry_run: args.dryRun,
      },
      null,
      2,
    ),
  );

  const model = queue.filters?.model || "small";
  const hasAudio = await fileExists(job.audio_path);
  if (!hasAudio || args.force) {
    await maybeRun("download audio", "node", [
      "pipeline/tools/download-youtube-audio-segment.mjs",
      job.watch_url,
      job.source_id,
      String(job.start_seconds),
      String(job.duration_seconds),
    ]);
  } else {
    console.log(`Audio already exists: ${job.audio_path}`);
  }

  await maybeRun("transcribe", "python3", [
    "pipeline/tools/transcribe_faster_whisper.py",
    job.audio_path,
    job.transcript_path,
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
    job.job_id,
    "--source-id",
    job.source_id,
    "--video-id",
    job.video_id,
    "--global-start",
    String(job.start_seconds),
    "--segments-csv",
    job.segments_csv_path,
  ]);

  await maybeRun("append segments", "node", [
    "pipeline/tools/append-transcript-segments.mjs",
    job.segments_csv_path,
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
