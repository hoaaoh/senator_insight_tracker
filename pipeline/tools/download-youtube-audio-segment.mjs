#!/usr/bin/env node

import { access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PYTHON = process.env.PYTHON || "python3";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYDEPS = path.join(PROJECT_ROOT, ".tools", "pydeps");
const RAW_DIR = path.join(PROJECT_ROOT, "data", "raw");
const CACHE_DIR = path.join(RAW_DIR, "cache");

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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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
const outputTemplate = `${sourceId}-${formatTime(startSeconds).replaceAll(":", "")}-${formatTime(endSeconds).replaceAll(":", "")}.%(ext)s`;
const segmentPath = path.join(RAW_DIR, outputTemplate.replace("%(ext)s", "m4a"));
const cachePath = path.join(CACHE_DIR, `${sourceId}.full.m4a`);

await mkdir(RAW_DIR, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });

if (!(await fileExists(cachePath))) {
  await run(
    PYTHON,
    [
      "-m",
      "yt_dlp",
      "--paths",
      CACHE_DIR,
      "-f",
      "bestaudio[ext=m4a]/bestaudio",
      "--extract-audio",
      "--audio-format",
      "m4a",
      "-o",
      `${sourceId}.full.%(ext)s`,
      url,
    ],
    {
      env: {
        ...process.env,
        PYTHONPATH: [PYDEPS, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    }
  );
} else {
  console.log(`Using cached audio: ${cachePath}`);
}

await run("ffmpeg", [
  "-y",
  "-ss",
  formatTime(startSeconds),
  "-t",
  String(durationSeconds),
  "-i",
  cachePath,
  "-vn",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  segmentPath,
]);

console.log(
  JSON.stringify(
    {
      sourceId,
      url,
      startSeconds,
      durationSeconds,
      endSeconds,
      rawDir: RAW_DIR,
      cachePath,
      segmentPath,
      outputTemplate,
    },
    null,
    2
  )
);
