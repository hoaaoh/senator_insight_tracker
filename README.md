# Political Project

板橋區議員議題趨勢與行動追蹤專案目前拆成兩個主要部分：

## `pipeline/`

質詢影片與公開資料處理管線。負責下載影音、ASR、人工校正、議員辨識、議題分類、行動摘要、notes 與 evidence 整理。

輸出給前端的靜態資料放在：

```text
pipeline/data/exports/
```

## `viewer/`

靜態查詢頁。負責 Heatmap、Timeline、政見對照、影片證據展開與篩選互動。

viewer 不做爬蟲、不跑 ASR，也不修改人工校正資料；它只讀 pipeline 匯出的靜態資料 bundle。

## `mvp/`

早期整合版，暫時保留作為相容與回退版本。後續確認 `pipeline/` 與 `viewer/` 穩定後，可以再移除或改成 redirect。

## 資料流

```text
議會影音 / 公開來源
→ pipeline raw data
→ ASR transcript
→ reviewed chunks
→ topic match + notes
→ actions / action evidence exports
→ viewer static dashboard
```

## 常用指令

```bash
node pipeline/tools/build-actions-js.mjs
node pipeline/tools/build-action-evidence-js.mjs
node pipeline/tools/build-pledges-js.mjs
node pipeline/tools/sync-viewer-data.mjs
node pipeline/tools/build-review-queue.mjs
python3 -m http.server 5173 --directory viewer
```

校正工具網址：

```text
/reviewer/review.html
```

## License

This repository uses layered licensing:

- Source code is licensed under the MIT License. See `LICENSE`.
- Curated datasets, labels, summaries, topic classifications, and review notes
  created for this project are licensed under CC BY 4.0. See `DATA_LICENSE.md`.
- Source materials such as election gazette PDFs, council video screenshots,
  YouTube videos, official records, news articles, and social media posts remain
  under their original source terms and are not relicensed by this repository.
  See `NOTICE.md`.
