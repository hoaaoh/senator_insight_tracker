#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PYTHON = process.env.PYTHON || "python3";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYDEPS = path.join(PROJECT_ROOT, ".tools", "pydeps");
const RAW_DIR = path.join(PROJECT_ROOT, "data", "raw");

function usage() {
  console.error(
    "Usage: node pipeline/tools/download-youtube-audio-segment.mjs <url> <source-id> <start-seconds> <duration-seconds>"
  );
}

function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

const [url, sourceId, startRaw, durationRaw] = process.argv.slice(2);
if (!url || !sourceId || !startRaw || !durationRaw) {
  usage();
  process.exit(1);
}

const startSeconds = Number(startRaw);
const durationSeconds = Number(durationRaw);
if (!Number.isFinite(startSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
  usage();
  process.exit(1);
}

const endSeconds = startSeconds + durationSeconds;
const section = `*${formatTime(startSeconds)}-${formatTime(endSeconds)}`;
const outputTemplate = `${sourceId}-${formatTime(startSeconds).replaceAll(":", "")}-${formatTime(endSeconds).replaceAll(":", "")}.%(ext)s`;

await mkdir(RAW_DIR, { recursive: true });

await run(
  PYTHON,
  [
    "-m",
    "yt_dlp",
    "--paths",
    RAW_DIR,
    "--download-sections",
    section,
    "--force-keyframes-at-cuts",
    "-f",
    "bestaudio[ext=m4a]/bestaudio",
    "--extract-audio",
    "--audio-format",
    "m4a",
    "-o",
    outputTemplate,
    url,
  ],
  {
    env: {
      ...process.env,
      PYTHONPATH: [PYDEPS, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  }
);

console.log(
  JSON.stringify(
    {
      sourceId,
      url,
      startSeconds,
      durationSeconds,
      endSeconds,
      section,
      rawDir: RAW_DIR,
      outputTemplate,
    },
    null,
    2
  )
);
