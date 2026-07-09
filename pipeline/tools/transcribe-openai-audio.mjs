#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

function usage() {
  console.error(
    "Usage: node pipeline/tools/transcribe-openai-audio.mjs <audio-path> <output-json-path> [model]"
  );
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

const [audioPathRaw, outputPathRaw, modelRaw] = process.argv.slice(2);
if (!audioPathRaw || !outputPathRaw) {
  usage();
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set. Export it before running transcription.");
  process.exit(2);
}

const audioPath = path.resolve(audioPathRaw);
const outputPath = path.resolve(outputPathRaw);
const model = modelRaw || "gpt-4o-transcribe-diarize";
const responseFormat = model.includes("diarize") ? "diarized_json" : "json";

await mkdir(path.dirname(outputPath), { recursive: true });

const args = [
  "--fail-with-body",
  "--silent",
  "--show-error",
  "--request",
  "POST",
  "--url",
  "https://api.openai.com/v1/audio/transcriptions",
  "--header",
  `Authorization: Bearer ${process.env.OPENAI_API_KEY}`,
  "--header",
  "Content-Type: multipart/form-data",
  "--form",
  `file=@${audioPath}`,
  "--form",
  `model=${model}`,
  "--form",
  `response_format=${responseFormat}`,
  "--output",
  outputPath,
];

if (model.includes("diarize")) {
  args.splice(args.length - 2, 0, "--form", "chunking_strategy=auto");
}

await run("curl", args);
console.log(
  JSON.stringify(
    {
      audioPath,
      outputPath,
      model,
      responseFormat,
    },
    null,
    2
  )
);
