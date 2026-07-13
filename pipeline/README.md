# Pipeline

這裡是質詢影片與公開來源的資料處理 project。目標是把「影音、社群、公文、新聞」轉成 viewer 可以穩定讀取的結構化資料。

## 責任範圍

- 來源登錄：議會影片、議員社群、議會公文、公報、新聞、輿情資料
- 影音下載：保留原始音訊、影片片段與來源時間戳
- ASR：用 faster-whisper 產生逐字稿初稿
- 校正：人工修正 speaker、文字、斷句與錯字
- Topic match：把質詢或行動對應到幾大議題分類
- Notes：保留分類理由、疑義、人工判斷與未確認處
- Evidence：保留影片 URL、起訖秒數、影格截圖與審核狀態
- Export：輸出給 viewer 的靜態資料

## 主要資料夾

```text
pipeline/
  tools/        # 下載、ASR、chunk、分類、匯出工具
  data/
    raw/        # 原始音訊與影片片段
    transcripts/# ASR JSON 與 segment CSV
    frames/     # 人工確認 speaker/證據用影格
    exports/    # viewer 可讀的靜態資料 bundle
  schemas/      # pipeline 與 viewer 的資料 contract
```

## 核心輸出

- `data/actions_banqiao_current.csv`
- `data/action_evidence_from_transcripts.csv`
- `data/pledges_2022_banqiao_current.csv`
- `data/exports/pledges.js`
- `data/exports/actions.js`
- `data/exports/actionEvidence.js`

## 一次更新 viewer 資料

```bash
node pipeline/tools/build-actions-js.mjs
node pipeline/tools/build-action-evidence-js.mjs
node pipeline/tools/build-pledges-js.mjs
node pipeline/tools/sync-viewer-data.mjs
node pipeline/tools/build-review-queue.mjs
```

## 質詢影片處理流程

```text
影片索引
→ download-youtube-audio/video-segment
→ transcribe_faster_whisper.py
→ append-transcript-segments.mjs
→ build-transcript-chunks.mjs
→ confirm-transcript-speakers.mjs
→ 人工整理 action/evidence CSV
→ build exports
→ sync viewer
```

目前 ASR 初稿仍需人工校正後才能視為可公開引用文字；viewer 端會顯示 `review_status` 以區分待查證與已確認資料。

## 建立新北市議會 YouTube 影片索引

```bash
node pipeline/tools/crawl-council-youtube-streams.mjs
```

預設會從「新北市議會網路直播」YouTube streams 頁面抓 114、115 年影片，輸出：

```text
pipeline/data/video_index/ntpc_council_youtube_streams.json
pipeline/data/video_index/ntpc_council_youtube_streams.csv
```

可調整民國年份或最多翻頁數：

```bash
node pipeline/tools/crawl-council-youtube-streams.mjs --years=113,114,115 --max-pages=30
```

## 建立 ASR 批次佇列

先從大會議事影音開始排程：

```bash
node pipeline/tools/build-asr-job-queue.mjs --priority=high --segment-seconds=1800
```

輸出：

```text
pipeline/data/asr_queue/ntpc_council_high_all_all_1800s.json
pipeline/data/asr_queue/ntpc_council_high_all_all_1800s.csv
```

先做單月試跑可加日期範圍：

```bash
node pipeline/tools/build-asr-job-queue.mjs \
  --priority=high \
  --date-from=2026-04-01 \
  --date-to=2026-04-30 \
  --segment-seconds=1800
```

目前五月到六月大會議事影音批次：

```bash
node pipeline/tools/build-asr-job-queue.mjs \
  --priority=high \
  --date-from=2026-05-01 \
  --date-to=2026-06-30 \
  --segment-seconds=1800
```

這會產生 32 支影片、208 個 30 分鐘 ASR job，總音訊長度約 94.85 小時。這批先作為 MVP 的主要 ASR 工作清單。

每個 job 會包含：

- YouTube 影片與時間範圍
- 預期音訊、逐字稿 JSON、segment CSV 路徑
- `download_command`
- `transcribe_command`
- `append_segments_command`

音訊下載工具會先快取整支 YouTube 音訊到：

```text
pipeline/data/raw/cache/<source-id>.full.m4a
```

後續同一支影片的不同 ASR job 會從本機 cache 切出片段，避免每段都重新從 YouTube 串流切片。這比直接用 `--download-sections` 穩定許多。

目前 faster-whisper 預設不開 `--vad-filter`。議會影片有時會被 VAD 誤判成全段無語音，導致 0 segment；先完整轉錄，再用後處理規則排除程序、空轉或非質詢片段。

先預覽第一個尚未轉錄的 job：

```bash
node pipeline/tools/run-asr-job.mjs --first --dry-run
```

執行指定 job：

```bash
node pipeline/tools/run-asr-job.mjs --job-id=<job_id>
```

## 產生人工校正 Queue

```bash
node pipeline/tools/build-review-queue.mjs
```

目前會從 `action_evidence_from_transcripts.csv` 與 `transcript_segments.csv` 產生：

```text
viewer/reviewer/review_queue.json
```

使用者可在 GitHub Pages 開啟 `/reviewer/review.html` 先選擇影片或片段；點進單一任務後會進入 `/reviewer/label.html?queue=<queue>.json` 校正。每個 queue 代表一支影片或一個明確片段，最後匯出的 JSON 只包含當前 queue 的人工校正結果。

更新公開任務清單：

```bash
node pipeline/tools/build-review-video-manifest.mjs
```

輸出：

```text
viewer/reviewer/video_manifest.json
```

這份檔案只放公開影片 metadata、ASR job 數、校正 queue path 與狀態，不放本機音訊、原始逐字稿或 `pipeline/data/` 內的工作檔。

## 產生 ASR 初步標註 Queue

針對單一 ASR segments CSV 產生 reviewer queue：

```bash
node pipeline/tools/build-asr-review-queue.mjs \
  --segments=pipeline/data/transcripts/<job>.segments.csv \
  --output=viewer/reviewer/asr_review_queue.json
```

開啟方式：

```text
/reviewer/label.html?queue=asr_review_queue.json
```

目前 labeling 是 `keyword-rules-v1`：會先合併相鄰 ASR segments，推測議題、行動類型、是否納入與 evidence role。這只是初稿，正式資料仍需人工確認。

## 轉換單支影片 ASR 結果

當同一支 YouTube 影片的 ASR jobs 都完成後，先跑：

```bash
node pipeline/tools/build-video-review-queues.mjs --video-id=<youtube_video_id>
```

這支工具會讀取該影片所有 `.segments.csv`，先用規則判斷是否值得人工校正：

- 若大量重複「法定人數不足」、片尾音樂或程序片段，會寫入 `viewer/reviewer/video_review_decisions.json` 並標成 `excluded`。
- 若看起來有有效質詢，會輸出單支影片 queue 到 `viewer/reviewer/queues/<queue-id>.json`，再由 reviewer 入口顯示為可校正。

接著重建公開清單：

```bash
node pipeline/tools/build-review-video-manifest.mjs
```

目前這是規則版 MVP。之後會把「單支影片 queue」再細切成多個「議員 × 議題/質詢段落」小題目。
