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
download-youtube-audio/video-segment
→ transcribe_faster_whisper.py
→ append-transcript-segments.mjs
→ build-transcript-chunks.mjs
→ confirm-transcript-speakers.mjs
→ 人工整理 action/evidence CSV
→ build exports
→ sync viewer
```

目前 ASR 初稿仍需人工校正後才能視為可公開引用文字；viewer 端會顯示 `review_status` 以區分待查證與已確認資料。

## 產生人工校正 Queue

```bash
node pipeline/tools/build-review-queue.mjs
```

目前會從 `action_evidence_from_transcripts.csv` 與 `transcript_segments.csv` 產生：

```text
viewer/reviewer/review_queue.json
```

使用者可在 GitHub Pages 開啟 `/reviewer/review.html` 校正，最後下載 JSON 或開 GitHub Issue 回傳。
