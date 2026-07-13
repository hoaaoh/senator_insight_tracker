const manifestUrl = "./queue_manifest.json";
const videoManifestUrl = "./video_manifest.json";
const storageVersion = "v2";

let queueManifest = { queues: [] };
let videoManifest = { targets: [] };
let groupMode = "year";

const elements = {
  meta: document.querySelector("#reviewHomeMeta"),
  targetCount: document.querySelector("#targetCount"),
  readyBar: document.querySelector("#readyBar"),
  targetSearch: document.querySelector("#targetSearch"),
  yearFilter: document.querySelector("#yearFilter"),
  issueFilter: document.querySelector("#issueFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  groupByCouncilor: document.querySelector("#homeGroupByCouncilor"),
  groupByYear: document.querySelector("#homeGroupByYear"),
  groupByIssue: document.querySelector("#homeGroupByIssue"),
  filteredCount: document.querySelector("#filteredCount"),
  targetList: document.querySelector("#targetList"),
};

function parseStoredJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function queueStorageKey(queueId) {
  return `review-submissions:${storageVersion}:${queueId}`;
}

function normalizeQueuePath(path) {
  return (path || "").replace(/^\.\//, "").replace(/^\/+/, "");
}

function formatDate(date) {
  if (!date) return "未標日期";
  return date.replaceAll("-", "/");
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours) return `${hours} 小時 ${String(minutes).padStart(2, "0")} 分`;
  return `${minutes} 分`;
}

function queueProgress(target) {
  if (!target.queue_id || !target.queue_path) {
    const statusLabels = {
      segments_ready: "ASR 已完成",
      asr_in_progress: "ASR 進行中",
      excluded: "已排除",
      asr_waiting: "ASR 待處理",
    };
    return {
      confirmed: 0,
      drafted: 0,
      total: target.item_count || 0,
      status: target.status_hint || "asr_waiting",
      label: statusLabels[target.status_hint] || "ASR 待處理",
    };
  }

  const stored = parseStoredJson(queueStorageKey(target.queue_id), {});
  const confirmed = Object.values(stored).filter(
    (submission) => submission.review_status === "confirmed"
  ).length;
  const drafted = Object.keys(stored).length;
  const total = target.item_count || 0;
  const status = total && confirmed >= total ? "done" : drafted ? "draft" : "ready";
  const label =
    status === "done" ? "已審閱" : status === "draft" ? "進行中" : target.status_label || "可校正";
  return { confirmed, drafted, total, status, label };
}

function statusPriority(target) {
  const progress = queueProgress(target);
  const priority = {
    draft: 0,
    ready: 1,
    done: 2,
    segments_ready: 3,
    asr_in_progress: 4,
    excluded: 8,
    asr_waiting: 9,
  };
  return priority[progress.status] ?? 9;
}

function compareTargets(a, b) {
  const statusSort = statusPriority(a) - statusPriority(b);
  if (statusSort) return statusSort;

  const dateSort = String(b.date || "").localeCompare(String(a.date || ""));
  if (dateSort) return dateSort;

  return String(a.title || "").localeCompare(String(b.title || ""), "zh-Hant");
}

function statusMatches(target, selectedStatus) {
  if (selectedStatus === "all") return true;
  const progress = queueProgress(target);
  if (selectedStatus === "asr_waiting") return !target.queue_path;
  return progress.status === selectedStatus;
}

function searchableText(target) {
  return [
    target.title,
    target.date,
    target.roc_year,
    target.councilor_name,
    target.video_id,
    ...(target.issue_labels || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function allTargets() {
  const targets = videoManifest.targets || [];
  const existing = new Set(targets.map((target) => target.queue_id).filter(Boolean));
  const queueOnly = (queueManifest.queues || [])
    .filter((entry) => !existing.has(entry.queue_id))
    .map((entry) => ({
      target_id: entry.queue_id,
      title: entry.title,
      date: entry.date || "",
      roc_year: entry.roc_year || "",
      councilor_id: entry.councilor_id || "",
      councilor_name: entry.councilor_name || "待辨識",
      issue_ids: entry.issue_ids || [],
      issue_labels: entry.issue_labels || ["待分類"],
      video_id: entry.video_id || "",
      queue_id: entry.queue_id,
      queue_path: entry.path,
      item_count: entry.item_count || 0,
      job_count: 0,
      duration_seconds: 0,
      status_hint: entry.status_hint || "ready",
      notes: "既有 reviewer queue，可直接校正。",
    }));
  return [...targets, ...queueOnly].sort(compareTargets);
}

function filteredTargets() {
  const search = elements.targetSearch.value.trim().toLowerCase();
  const year = elements.yearFilter.value;
  const issue = elements.issueFilter.value;
  const status = elements.statusFilter.value;

  return allTargets()
    .filter((target) => {
      if (search && !searchableText(target).includes(search)) return false;
      if (year !== "all" && target.roc_year !== year) return false;
      if (issue !== "all" && !(target.issue_ids || []).includes(issue) && !(target.issue_labels || []).includes(issue)) {
        return false;
      }
      if (!statusMatches(target, status)) return false;
      return true;
    })
    .sort(compareTargets);
}

function groupTargets(targets) {
  const groups = new Map();
  for (const target of targets) {
    let key = target.roc_year || "未分類年度";
    if (groupMode === "councilor") key = target.councilor_name || "待辨識";
    if (groupMode === "issue") key = (target.issue_labels || ["待分類"])[0] || "待分類";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(target);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => String(b).localeCompare(String(a), "zh-Hant"));
}

function renderFilters() {
  const targets = allTargets();
  const years = Array.from(new Set(targets.map((target) => target.roc_year).filter(Boolean))).sort((a, b) =>
    String(b).localeCompare(String(a), "zh-Hant")
  );
  const issues = new Map();
  for (const target of targets) {
    const ids = target.issue_ids || [];
    const labels = target.issue_labels || [];
    labels.forEach((label, index) => issues.set(ids[index] || label, label));
  }

  elements.yearFilter.innerHTML = [
    `<option value="all">全部年度</option>`,
    ...years.map((year) => `<option value="${year}">${year} 年</option>`),
  ].join("");

  elements.issueFilter.innerHTML = [
    `<option value="all">全部分類</option>`,
    ...Array.from(issues.entries()).map(([value, label]) => `<option value="${value}">${label}</option>`),
  ].join("");
}

function renderSummary() {
  const targets = allTargets();
  const ready = targets.filter((target) => target.queue_path).length;
  const segmentsReady = targets.filter((target) => target.status_hint === "segments_ready").length;
  const excluded = targets.filter((target) => target.status_hint === "excluded").length;
  const waiting = targets.filter((target) => target.status_hint === "asr_waiting").length;
  elements.targetCount.textContent = String(targets.length);
  elements.readyBar.style.width = `${targets.length ? Math.round(((ready + segmentsReady) / targets.length) * 100) : 0}%`;
  elements.meta.textContent = `目前清單包含 ${targets.length} 個影片/片段，${ready} 個可直接校正，${segmentsReady} 個 ASR 已完成待切題，${excluded} 個已排除，${waiting} 個 ASR 待處理。`;
}

function renderGroupTabs() {
  elements.groupByCouncilor.classList.toggle("active", groupMode === "councilor");
  elements.groupByYear.classList.toggle("active", groupMode === "year");
  elements.groupByIssue.classList.toggle("active", groupMode === "issue");
}

function targetStatusClass(status) {
  if (status === "done") return "done";
  if (status === "draft") return "draft";
  if (status === "ready") return "ready";
  if (status === "excluded") return "excluded";
  return "asr-waiting";
}

function renderTargetCard(target) {
  const progress = queueProgress(target);
  const statusClass = targetStatusClass(progress.status);
  const issueText = (target.issue_labels || ["待分類"]).join("、");
  const metaParts = [
    formatDate(target.date),
    target.councilor_name || "待辨識",
    issueText,
    target.is_partial ? "部分 ASR" : "",
    target.job_count ? `${target.job_count} 個 ASR job` : "",
    target.duration_seconds ? formatDuration(target.duration_seconds) : "",
  ].filter(Boolean);
  const action = target.queue_path
    ? `<a class="target-action primary" href="./label.html?queue=${encodeURIComponent(normalizeQueuePath(target.queue_path))}">開始校正</a>`
    : `<button class="target-action" type="button" disabled>${progress.status === "excluded" ? "已排除" : progress.status === "segments_ready" ? "待切題" : "等待 ASR"}</button>`;

  return `
    <article class="target-item ${statusClass}">
      <span class="task-dot ${progress.status === "ready" ? "" : progress.status}" aria-hidden="true"></span>
      <div class="target-main">
        <div class="target-title-row">
          <h3>${target.title || target.video_id || target.target_id}</h3>
          <span class="target-status ${statusClass}">${progress.label}</span>
        </div>
        <p class="target-meta">${metaParts.join("｜")}</p>
        <p class="target-notes">${target.notes || ""}</p>
        <div class="target-footer">
          <span>${target.queue_path ? `${progress.confirmed}/${progress.total} 已確認` : `預估 ASR ${target.queued_hours || 0} 小時`}</span>
          ${action}
        </div>
      </div>
    </article>
  `;
}

function renderTargets() {
  renderGroupTabs();
  const targets = filteredTargets();
  elements.filteredCount.textContent = `${targets.length} 筆`;
  if (!targets.length) {
    elements.targetList.innerHTML = `<p class="empty-state">沒有符合條件的影片或片段。</p>`;
    return;
  }

  elements.targetList.innerHTML = groupTargets(targets)
    .map(
      ([groupName, groupItems]) => `
        <section class="target-group">
          <div class="target-group-title">${groupName}</div>
          ${groupItems.map(renderTargetCard).join("")}
        </section>
      `
    )
    .join("");
}

async function fetchJson(url, fallback) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
  } catch (error) {
    console.warn(error);
    return fallback;
  }
}

async function init() {
  queueManifest = await fetchJson(manifestUrl, { queues: [] });
  videoManifest = await fetchJson(videoManifestUrl, { targets: [] });
  renderFilters();
  renderSummary();
  renderTargets();

  elements.targetSearch.addEventListener("input", renderTargets);
  elements.yearFilter.addEventListener("change", renderTargets);
  elements.issueFilter.addEventListener("change", renderTargets);
  elements.statusFilter.addEventListener("change", renderTargets);
  elements.groupByCouncilor.addEventListener("click", () => {
    groupMode = "councilor";
    renderTargets();
  });
  elements.groupByYear.addEventListener("click", () => {
    groupMode = "year";
    renderTargets();
  });
  elements.groupByIssue.addEventListener("click", () => {
    groupMode = "issue";
    renderTargets();
  });
}

init().catch((error) => {
  console.error(error);
  elements.meta.textContent = "任務清單載入失敗，請確認 queue_manifest.json 與 video_manifest.json。";
});
