#!/usr/bin/env python3

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYDEPS = ROOT / ".tools" / "pydeps"
MODEL_DIR = ROOT / ".tools" / "faster-whisper-models"
HF_HOME = ROOT / ".tools" / "hf-cache"

sys.path.insert(0, str(PYDEPS))
os.environ.setdefault("HF_HOME", str(HF_HOME))

from faster_whisper import WhisperModel  # noqa: E402


def parse_args():
    parser = argparse.ArgumentParser(description="Transcribe audio with faster-whisper.")
    parser.add_argument("audio_path")
    parser.add_argument("output_json")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--vad-filter", action="store_true")
    parser.add_argument("--job-id", default="")
    parser.add_argument("--source-id", default="")
    parser.add_argument("--video-id", default="")
    parser.add_argument("--global-start", type=float, default=0)
    parser.add_argument("--segments-csv", default="")
    return parser.parse_args()


def write_segments_csv(path, args, segments):
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    headers = [
        "segment_id",
        "job_id",
        "source_id",
        "video_id",
        "start_seconds",
        "end_seconds",
        "speaker",
        "speaker_confidence",
        "text",
        "issue_id",
        "action_type",
        "action_weight",
        "review_status",
        "notes",
    ]
    with output_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=headers)
        writer.writeheader()
        for index, segment in enumerate(segments, start=1):
            global_start = args.global_start + segment["start"]
            global_end = args.global_start + segment["end"]
            writer.writerow(
                {
                    "segment_id": f"{args.job_id or 'segment'}-{index:04d}",
                    "job_id": args.job_id,
                    "source_id": args.source_id,
                    "video_id": args.video_id,
                    "start_seconds": f"{global_start:.2f}",
                    "end_seconds": f"{global_end:.2f}",
                    "speaker": "",
                    "speaker_confidence": "unknown",
                    "text": segment["text"],
                    "issue_id": "",
                    "action_type": "質詢逐字稿候選",
                    "action_weight": "",
                    "review_status": "needs_review",
                    "notes": "faster-whisper 初稿，需人工校對發言者與議題",
                }
            )


def main():
    args = parse_args()
    audio_path = Path(args.audio_path).resolve()
    output_json = Path(args.output_json).resolve()
    output_json.parent.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    HF_HOME.mkdir(parents=True, exist_ok=True)

    started_at = time.time()
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        download_root=str(MODEL_DIR),
    )
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=args.language,
        beam_size=args.beam_size,
        vad_filter=args.vad_filter,
    )
    segments = [
        {
            "id": index,
            "start": round(segment.start, 3),
            "end": round(segment.end, 3),
            "text": segment.text.strip(),
            "avg_logprob": getattr(segment, "avg_logprob", None),
            "no_speech_prob": getattr(segment, "no_speech_prob", None),
        }
        for index, segment in enumerate(segments_iter, start=1)
    ]
    elapsed_seconds = time.time() - started_at

    result = {
        "audio_path": str(audio_path),
        "model": args.model,
        "device": args.device,
        "compute_type": args.compute_type,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "duration_after_vad": getattr(info, "duration_after_vad", None),
        "elapsed_seconds": elapsed_seconds,
        "global_start": args.global_start,
        "segments": segments,
    }

    output_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.segments_csv:
        write_segments_csv(args.segments_csv, args, segments)

    print(json.dumps({k: result[k] for k in result if k != "segments"} | {"segment_count": len(segments)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
