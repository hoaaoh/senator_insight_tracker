# Viewer

這裡是靜態查詢網頁 project。它只負責讀取 pipeline 匯出的資料並做視覺化。

## 責任範圍

- 民代 x 議題 Heatmap
- 行動指數 Timeline
- 議題輿情趨勢
- 政見對照
- 影片證據展開
- 月份、民代、議題篩選
- `/election-map.html` 2026 新北市議員參選地圖
- `/reviewer/review.html` 人工校正工作台

## 不負責的事情

- 不下載影片
- 不跑 ASR
- 不做爬蟲
- 不直接修改人工校正資料

## 資料來源

目前 viewer 讀取這些靜態檔：

```text
data.js
pledges.js
actions.js
actionEvidence.js
```

其中 `pledges.js`、`actions.js` 與 `actionEvidence.js` 應由 pipeline 產生後同步過來：

```bash
node pipeline/tools/build-actions-js.mjs
node pipeline/tools/build-action-evidence-js.mjs
node pipeline/tools/build-pledges-js.mjs
node pipeline/tools/sync-viewer-data.mjs
```

## 啟動

```bash
python3 -m http.server 5173 --directory viewer
```

然後開啟：

```text
http://localhost:5173/
```

參選地圖：

```text
http://localhost:5173/election-map.html
```

校正工作台：

```text
http://localhost:5173/reviewer/review.html
```
