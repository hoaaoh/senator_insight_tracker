#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PIPELINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PIPELINE_ROOT, "..");
const EXPORT_DIR = path.join(PIPELINE_ROOT, "data", "exports");
const VIEWER_ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(REPO_ROOT, "viewer");

const FILES = ["pledges.js", "actions.js", "actionEvidence.js"];

await mkdir(VIEWER_ROOT, { recursive: true });

for (const file of FILES) {
  await copyFile(path.join(EXPORT_DIR, file), path.join(VIEWER_ROOT, file));
}

console.log(
  JSON.stringify(
    {
      export_dir: EXPORT_DIR,
      viewer_root: VIEWER_ROOT,
      synced_files: FILES,
    },
    null,
    2
  )
);
