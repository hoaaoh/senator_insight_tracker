const queueParam = new URLSearchParams(window.location.search).get("queue") || "review_queue.json";
const queueUrl = queueParam.startsWith("http") || queueParam.startsWith("./")
  ? queueParam
  : `./${queueParam.replace(/^\/+/, "")}`;
const manifestUrl = "./queue_manifest.json";
const data = window.MVP_DATA || { representatives: [], issues: [] };
const storageVersion = "v2";
const queueBatchSize = 10;

const speakerOptions = [
  ...data.representatives.map((rep) => ({ id: rep.id, label: rep.name })),
  { id: "official", label: "官員答覆" },
  { id: "chair", label: "主席/議事人員" },
  { id: "not_target", label: "非目標選區議員" },
  { id: "unknown", label: "不確定" },
];

let queue = null;
let queueManifest = { queues: [] };
let taskGroupMode = "councilor";
let activeIndex = 0;
let submissions = {};
let ytApiPromise = null;
let ytPlayer = null;
let ytPlayerReady = false;
let activeEvidenceClip = null;
let stopCheckTimer = null;

const elements = {
  queueMeta: document.querySelector("#queueMeta"),
  queueList: document.querySelector("#queueList"),
  progressText: document.querySelector("#progressText"),
  progressBar: document.querySelector("#progressBar"),
  reviewerName: document.querySelector("#reviewerName"),
  reviewerDialog: document.querySelector("#reviewerDialog"),
  reviewerDialogForm: document.querySelector("#reviewerDialogForm"),
  reviewerDialogName: document.querySelector("#reviewerDialogName"),
  githubRepo: document.querySelector("#githubRepo"),
  groupByCouncilor: document.querySelector("#groupByCouncilor"),
  groupByYear: document.querySelector("#groupByYear"),
  taskList: document.querySelector("#taskList"),
  itemTitle: document.querySelector("#itemTitle"),
  itemCounter: document.querySelector("#itemCounter"),
  youtubePlayer: document.querySelector("#youtubePlayer"),
  frameFallback: document.querySelector("#frameFallback"),
  evidenceFrame: document.querySelector("#evidenceFrame"),
  frameCaption: document.querySelector("#frameCaption"),
  sourceLink: document.querySelector("#sourceLink"),
  timeRange: document.querySelector("#timeRange"),
  suggestedSpeaker: document.querySelector("#suggestedSpeaker"),
  suggestedIssue: document.querySelector("#suggestedIssue"),
  suggestedRole: document.querySelector("#suggestedRole"),
  asrText: document.querySelector("#asrText"),
  includeStatus: document.querySelector("#includeStatus"),
  speakerId: document.querySelector("#speakerId"),
  speakerConfidence: document.querySelector("#speakerConfidence"),
  primaryIssue: document.querySelector("#primaryIssue"),
  secondaryIssues: document.querySelector("#secondaryIssues"),
  actionType: document.querySelector("#actionType"),
  actionIntent: document.querySelector("#actionIntent"),
  evidenceRole: document.querySelector("#evidenceRole"),
  evidenceRoleHelp: document.querySelector("#evidenceRoleHelp"),
  questionQualityScore: document.querySelector("#questionQualityScore"),
  questionQualityHelp: document.querySelector("#questionQualityHelp"),
  questionQualityNotes: document.querySelector("#questionQualityNotes"),
  correctedText: document.querySelector("#correctedText"),
  reviewNotes: document.querySelector("#reviewNotes"),
  replayEvidence: document.querySelector("#replayEvidence"),
  contextEvidence: document.querySelector("#contextEvidence"),
  prevItem: document.querySelector("#prevItem"),
  skipItem: document.querySelector("#skipItem"),
  saveDraft: document.querySelector("#saveDraft"),
  confirmItem: document.querySelector("#confirmItem"),
  nextItem: document.querySelector("#nextItem"),
  exportJson: document.querySelector("#exportJson"),
  openIssue: document.querySelector("#openIssue"),
};

const evidenceRoleDescriptions = {
  core: "核心證據：這段直接代表此筆 action 的主要主張、追問或要求。",
  detail: "補充細節：這段補充背景、金額、官員答覆或制度機制。",
  tail: "收尾結論：這段是質詢尾聲、主席回應、要求列入或要求專案報告。",
  exclude: "排除：這段不應納入此 action，例如換下一位議員、程序發言或內容無關。",
};

const questionQualityDescriptions = {
  "5": "具體、有追問、有明確要求或後續追蹤。",
  "4": "清楚且有追問，但要求或追蹤條件略弱。",
  "3": "有議題與基本質詢，但要求較籠統。",
  "2": "偏宣示或鋪陳，具體監督效果有限。",
  "1": "程序、離題、寒暄或幾乎沒有實質質詢。",
};

function storageKey() {
  return `review-submissions:${storageVersion}:${queue.queue_id}`;
}

function queueStorageKey(queueId) {
  return `review-submissions:${storageVersion}:${queueId}`;
}

function reviewerKey() {
  return `reviewer-profile:${storageVersion}`;
}

function parseStoredJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function normalizeQueuePath(path) {
  return (path || "review_queue.json").replace(/^\.\//, "").replace(/^\/+/, "");
}

function makeReviewerDeviceId() {
  const randomId =
    window.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `reviewer-${randomId}`;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":");
}

function getVideoId(item) {
  if (item.video_id) return item.video_id;
  try {
    const url = new URL(item.source_url || item.watch_url || "");
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.split("/").filter(Boolean)[0] || queue.source_video_id || "";
    }
    return url.searchParams.get("v") || queue.source_video_id || "";
  } catch {
    return queue.source_video_id || "";
  }
}

function youtubeWatchUrl(item, offsetSeconds = 0) {
  const videoId = getVideoId(item);
  if (!videoId) return item.source_url || "";
  const start = Math.max(0, Math.floor(Number(item.start_seconds || 0) + offsetSeconds));
  return `https://www.youtube.com/watch?v=${videoId}&t=${start}s`;
}

function youtubeEmbedUrl(item, options = {}) {
  const clip = evidenceClip(item, options);
  if (!clip.videoId) return "";
  const params = new URLSearchParams({
    start: String(clip.start),
    end: String(clip.end),
    controls: "1",
    enablejsapi: "1",
    rel: "0",
    playsinline: "1",
  });
  if (window.location.origin && window.location.origin !== "null") {
    params.set("origin", window.location.origin);
  }
  if (options.autoplay) params.set("autoplay", "1");
  return `https://www.youtube.com/embed/${clip.videoId}?${params.toString()}`;
}

function evidenceClip(item, options = {}) {
  const videoId = getVideoId(item);
  const startOffset = options.startOffset || 0;
  const endOffset = options.endOffset || 0;
  const start = Math.max(0, Math.floor(Number(item.start_seconds || 0) + startOffset));
  const end = Math.max(start + 1, Math.ceil(Number(item.end_seconds || start + 1) + endOffset));
  return {
    videoId,
    start,
    end,
    autoplay: Boolean(options.autoplay),
    watchUrl: youtubeWatchUrl(item, startOffset),
  };
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === "function") previousReady();
      resolve();
    };

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.append(script);
    }
  });

  return ytApiPromise;
}

async function ensureYouTubePlayer() {
  if (!activeEvidenceClip?.videoId) return null;
  await loadYouTubeApi();
  if (ytPlayer) return ytPlayer;

  ytPlayer = new YT.Player("youtubePlayer", {
    events: {
      onReady: () => {
        ytPlayerReady = true;
        loadEvidenceClip(activeEvidenceClip);
      },
      onStateChange: (event) => {
        if (event.data === YT.PlayerState.PLAYING) startStopCheck();
        else stopStopCheck();
      },
    },
  });
  return ytPlayer;
}

function loadEvidenceClip(clip) {
  if (!ytPlayer || !ytPlayerReady || !clip?.videoId) return;
  const method = clip.autoplay ? "loadVideoById" : "cueVideoById";
  ytPlayer[method]({
    videoId: clip.videoId,
    startSeconds: clip.start,
    endSeconds: clip.end,
  });
  if (clip.autoplay) startStopCheck();
}

function startStopCheck() {
  stopStopCheck();
  stopCheckTimer = window.setInterval(() => {
    if (!ytPlayer || !activeEvidenceClip) return;
    const currentTime = typeof ytPlayer.getCurrentTime === "function" ? ytPlayer.getCurrentTime() : 0;
    if (currentTime >= activeEvidenceClip.end - 0.15) {
      ytPlayer.pauseVideo();
      ytPlayer.seekTo(activeEvidenceClip.end, true);
      stopStopCheck();
    }
  }, 250);
}

function stopStopCheck() {
  if (!stopCheckTimer) return;
  window.clearInterval(stopCheckTimer);
  stopCheckTimer = null;
}

function defaultRepo() {
  const host = window.location.hostname;
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (host.endsWith(".github.io") && parts.length) {
    return `${host.replace(".github.io", "")}/${parts[0]}`;
  }
  return "hoaaoh/senator_insight_tracker";
}

function loadProfile() {
  const profile = JSON.parse(localStorage.getItem(reviewerKey()) || "{}");
  if (!profile.reviewer_device_id) {
    profile.reviewer_device_id = makeReviewerDeviceId();
    localStorage.setItem(reviewerKey(), JSON.stringify(profile));
  }
  elements.reviewerName.value = profile.reviewer_name || "";
  elements.reviewerName.dataset.deviceId = profile.reviewer_device_id;
  elements.githubRepo.value = profile.github_repo?.trim() || defaultRepo();
  return profile;
}

function saveProfile() {
  const existing = JSON.parse(localStorage.getItem(reviewerKey()) || "{}");
  localStorage.setItem(
    reviewerKey(),
    JSON.stringify({
      reviewer_name: elements.reviewerName.value.trim(),
      reviewer_device_id: existing.reviewer_device_id || makeReviewerDeviceId(),
      github_repo: elements.githubRepo.value.trim(),
    })
  );
  elements.reviewerName.dataset.deviceId =
    JSON.parse(localStorage.getItem(reviewerKey()) || "{}").reviewer_device_id || "";
}

function currentReviewerDeviceId() {
  return JSON.parse(localStorage.getItem(reviewerKey()) || "{}").reviewer_device_id || "";
}

function ensureReviewerIdentity() {
  const profile = JSON.parse(localStorage.getItem(reviewerKey()) || "{}");
  if (profile.reviewer_name?.trim()) return;

  if (!elements.reviewerDialog?.showModal) {
    const name = window.prompt("請填寫你的名字或代號，之後此裝置會自動沿用。");
    if (name?.trim()) {
      elements.reviewerName.value = name.trim();
      saveProfile();
    }
    return;
  }

  elements.reviewerDialogName.value = elements.reviewerName.value.trim();
  elements.reviewerDialog.showModal();
}

function loadSubmissions() {
  submissions = JSON.parse(localStorage.getItem(storageKey()) || "{}");
}

function saveSubmissions() {
  localStorage.setItem(storageKey(), JSON.stringify(submissions));
}

function setupOptions() {
  elements.speakerId.innerHTML = speakerOptions
    .map((speaker) => `<option value="${speaker.id}">${speaker.label}</option>`)
    .join("");

  elements.primaryIssue.innerHTML = data.issues
    .map((issue) => `<option value="${issue.id}">${issue.label}</option>`)
    .join("");

  elements.secondaryIssues.innerHTML = data.issues
    .map(
      (issue) => `
        <label>
          <input type="checkbox" value="${issue.id}" />
          ${issue.label}
        </label>
      `
    )
    .join("");
}

async function loadQueueManifest() {
  try {
    queueManifest = await fetch(manifestUrl).then((response) => {
      if (!response.ok) throw new Error(`Manifest not found: ${response.status}`);
      return response.json();
    });
  } catch {
    queueManifest = {
      queues: [
        {
          queue_id: queue.queue_id,
          path: normalizeQueuePath(queueParam),
          title: queue.title,
          councilor_name: "目前任務",
          roc_year: queue.council_date ? String(Number(queue.council_date.slice(0, 4)) - 1911) : "未分類",
          date: queue.council_date || "",
          item_count: queue.items.length,
        },
      ],
    };
  }
}

function queueProgress(entry) {
  const stored = parseStoredJson(queueStorageKey(entry.queue_id), {});
  const confirmed = Object.values(stored).filter(
    (submission) => submission.review_status === "confirmed"
  ).length;
  const drafted = Object.keys(stored).length;
  const total = entry.item_count || 0;
  const status = total && confirmed >= total ? "done" : drafted ? "draft" : "new";
  return { confirmed, drafted, total, status };
}

function groupManifestEntries(entries) {
  const groupKey = taskGroupMode === "year" ? "roc_year" : "councilor_name";
  const fallback = taskGroupMode === "year" ? "未分類年度" : "未分類議員";
  const groups = new Map();
  for (const entry of entries) {
    const key = entry[groupKey] || fallback;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => String(b).localeCompare(String(a), "zh-Hant"));
}

function renderTaskList() {
  const entries = queueManifest.queues || [];
  if (!entries.length) {
    elements.taskList.innerHTML = `<p class="task-meta">尚未建立任務列表</p>`;
    return;
  }

  const currentPath = normalizeQueuePath(queueParam);
  elements.groupByCouncilor.classList.toggle("active", taskGroupMode === "councilor");
  elements.groupByYear.classList.toggle("active", taskGroupMode === "year");

  elements.taskList.innerHTML = groupManifestEntries(entries)
    .map(([groupName, groupEntries]) => {
      const items = groupEntries
        .map((entry) => {
          const progress = queueProgress(entry);
          const isActive =
            entry.queue_id === queue.queue_id || normalizeQueuePath(entry.path) === currentPath;
          const statusText =
            progress.status === "done"
              ? "已審閱"
              : progress.status === "draft"
                ? "進行中"
                : "未審閱";
          return `
            <button class="task-item ${isActive ? "active" : ""}" type="button" data-queue-path="${entry.path}">
              <span class="task-dot ${progress.status}" aria-hidden="true"></span>
              <span>
                <span class="task-title">${entry.title}</span>
                <span class="task-meta">${entry.date || ""}｜${statusText}｜${progress.confirmed}/${progress.total}</span>
              </span>
            </button>
          `;
        })
        .join("");
      return `
        <section class="task-group">
          <div class="task-group-title">${groupName}</div>
          ${items}
        </section>
      `;
    })
    .join("");

  elements.taskList.querySelectorAll(".task-item").forEach((button) => {
    button.addEventListener("click", () => {
      const nextPath = normalizeQueuePath(button.dataset.queuePath);
      if (!nextPath || nextPath === currentPath) return;
      saveCurrent("draft");
      window.location.href = `./label.html?queue=${encodeURIComponent(nextPath)}`;
    });
  });
}

function getCurrentItem() {
  return queue.items[activeIndex];
}

function getDraft(item) {
  return submissions[item.chunk_id] || null;
}

function collectForm(status) {
  const item = getCurrentItem();
  const secondaryIssues = Array.from(
    elements.secondaryIssues.querySelectorAll("input:checked")
  ).map((input) => input.value);

  return {
    queue_id: queue.queue_id,
    queue_item_id: item.queue_item_id,
    chunk_id: item.chunk_id,
    action_id: item.action_id,
    source_url: item.source_url,
    video_id: getVideoId(item),
    watch_url: youtubeWatchUrl(item),
    embed_url: youtubeEmbedUrl(item),
    start_seconds: item.start_seconds,
    end_seconds: item.end_seconds,
    reviewer_id: elements.reviewerName.value.trim(),
    reviewer_device_id: currentReviewerDeviceId(),
    include_status: elements.includeStatus.value,
    speaker_id: elements.speakerId.value,
    speaker_confidence: elements.speakerConfidence.value,
    primary_issue: elements.primaryIssue.value,
    secondary_issues: secondaryIssues,
    action_type: elements.actionType.value,
    action_intent: elements.actionIntent.value.trim(),
    evidence_role: elements.evidenceRole.value,
    question_quality_score: elements.questionQualityScore.value
      ? Number(elements.questionQualityScore.value)
      : null,
    question_quality_notes: elements.questionQualityNotes.value.trim(),
    asr_text: item.asr_text,
    corrected_text: elements.correctedText.value.trim(),
    notes: elements.reviewNotes.value.trim(),
    review_status: status,
    updated_at: new Date().toISOString(),
  };
}

function saveCurrent(status = "draft") {
  const item = getCurrentItem();
  submissions[item.chunk_id] = collectForm(status);
  saveProfile();
  saveSubmissions();
  renderTaskList();
  renderQueueList();
  renderProgress();
}

function applyItemToForm(item) {
  const draft = getDraft(item);
  const speakerId =
    draft?.speaker_id ||
    speakerOptions.find((speaker) => speaker.label === item.representative_name)?.id ||
    item.representative_id ||
    "unknown";

  elements.itemTitle.textContent = item.suggested_summary || item.chunk_id;
  elements.itemCounter.textContent = `${activeIndex + 1} / ${queue.items.length}`;
  renderEvidencePlayer(item);
  elements.sourceLink.href = youtubeWatchUrl(item);
  elements.suggestedSpeaker.textContent = item.representative_name || "--";
  elements.suggestedIssue.textContent = item.suggested_primary_issue_label || "--";
  elements.suggestedRole.textContent = item.suggested_evidence_role || "--";
  elements.asrText.textContent = item.asr_text || "沒有 ASR 文字";

  elements.includeStatus.value = draft?.include_status || item.suggested_include_status || "include";
  elements.speakerId.value = speakerId;
  elements.speakerConfidence.value = draft?.speaker_confidence || "confirmed";
  elements.primaryIssue.value = draft?.primary_issue || item.suggested_primary_issue || "transport";
  elements.actionType.value = draft?.action_type || item.suggested_action_type || "質詢";
  elements.actionIntent.value = draft?.action_intent || item.suggested_summary || "";
  elements.evidenceRole.value = draft?.evidence_role || item.suggested_evidence_role || "detail";
  elements.questionQualityScore.value =
    draft?.question_quality_score == null ? "" : String(draft.question_quality_score);
  elements.questionQualityNotes.value = draft?.question_quality_notes || "";
  elements.correctedText.value = draft?.corrected_text || item.asr_text || "";
  elements.reviewNotes.value = draft?.notes || item.suggested_notes || "";
  updateEvidenceRoleHelp();
  updateQuestionQualityHelp();

  const secondaryIssues = new Set(draft?.secondary_issues || []);
  elements.secondaryIssues.querySelectorAll("input").forEach((input) => {
    input.checked = secondaryIssues.has(input.value);
  });
}

function renderEvidencePlayer(item, options = {}) {
  const embedUrl = youtubeEmbedUrl(item, options);
  activeEvidenceClip = evidenceClip(item, options);
  if (!ytPlayer) elements.youtubePlayer.src = embedUrl;
  elements.youtubePlayer.dataset.clipStart = String(activeEvidenceClip.start);
  elements.youtubePlayer.dataset.clipEnd = String(activeEvidenceClip.end);
  elements.youtubePlayer.hidden = !embedUrl;
  elements.frameFallback.hidden = Boolean(embedUrl) || !item.evidence_frame;
  elements.evidenceFrame.src = item.evidence_frame || "";
  elements.evidenceFrame.hidden = !item.evidence_frame;
  elements.frameCaption.textContent = item.evidence_frame ? "YouTube 無法嵌入時可用的備援影格" : "無影格";
  elements.sourceLink.href = youtubeWatchUrl(item, options.startOffset || 0);
  const hasContext = Boolean(options.startOffset || options.endOffset);
  elements.timeRange.textContent = `${formatTime(activeEvidenceClip.start)} - ${formatTime(activeEvidenceClip.end)}${hasContext ? "（含前後 5 秒）" : ""}`;
  if (embedUrl) {
    ensureYouTubePlayer()
      .then(() => loadEvidenceClip(activeEvidenceClip))
      .catch((error) => console.warn("YouTube player API unavailable", error));
  } else {
    stopStopCheck();
  }
}

function updateEvidenceRoleHelp() {
  elements.evidenceRoleHelp.textContent =
    evidenceRoleDescriptions[elements.evidenceRole.value] || "";
}

function updateQuestionQualityHelp() {
  elements.questionQualityHelp.textContent =
    questionQualityDescriptions[elements.questionQualityScore.value] || "尚未評分。";
}

function itemReviewStatus(item) {
  const draft = getDraft(item);
  if (draft?.review_status === "confirmed") {
    return { key: "done", label: "已確認" };
  }
  if (draft) {
    return { key: "draft", label: "草稿" };
  }
  return { key: "new", label: "未審" };
}

function renderQueueList() {
  const total = queue.items.length;
  const batchCount = Math.max(1, Math.ceil(total / queueBatchSize));
  const activeBatchIndex = Math.floor(activeIndex / queueBatchSize);
  const batchStart = activeBatchIndex * queueBatchSize;
  const batchEnd = Math.min(total, batchStart + queueBatchSize);
  const batchItems = queue.items.slice(batchStart, batchEnd);
  const confirmedInBatch = batchItems.filter(
    (item) => itemReviewStatus(item).key === "done"
  ).length;

  const itemsHtml = batchItems
    .map((item, offset) => {
      const index = batchStart + offset;
      const status = itemReviewStatus(item);
      return `
        <button class="queue-item ${index === activeIndex ? "active" : ""} ${status.key === "done" ? "done" : ""}" type="button" data-index="${index}">
          <strong>${String(index + 1).padStart(2, "0")} ${item.suggested_evidence_role}</strong>
          <small>${formatTime(item.start_seconds)} / ${status.label}</small>
        </button>
      `;
    })
    .join("");

  elements.queueList.innerHTML = `
    <section class="queue-batch-card" aria-label="目前片段組">
      <div>
        <strong>第 ${activeBatchIndex + 1} 組</strong>
        <span>${batchStart + 1}-${batchEnd} / ${total}｜本組已確認 ${confirmedInBatch}/${batchItems.length}</span>
      </div>
      <div class="queue-batch-actions">
        <button class="queue-batch-button" type="button" data-batch-index="${activeBatchIndex - 1}" ${activeBatchIndex === 0 ? "disabled" : ""}>上一組</button>
        <button class="queue-batch-button" type="button" data-batch-index="${activeBatchIndex + 1}" ${activeBatchIndex >= batchCount - 1 ? "disabled" : ""}>下一組</button>
      </div>
    </section>
    <div class="queue-batch-items">
      ${itemsHtml}
    </div>
  `;

  elements.queueList.querySelectorAll(".queue-batch-button").forEach((button) => {
    button.addEventListener("click", () => {
      const nextBatchIndex = Number(button.dataset.batchIndex);
      if (!Number.isFinite(nextBatchIndex) || nextBatchIndex < 0 || nextBatchIndex >= batchCount) {
        return;
      }
      saveCurrent("draft");
      activeIndex = Math.min(total - 1, nextBatchIndex * queueBatchSize);
      renderActiveItem();
    });
  });

  elements.queueList.querySelectorAll(".queue-item").forEach((button) => {
    button.addEventListener("click", () => {
      saveCurrent("draft");
      activeIndex = Number(button.dataset.index);
      renderActiveItem();
    });
  });
}

function renderProgress() {
  const confirmed = Object.values(submissions).filter(
    (submission) => submission.review_status === "confirmed"
  ).length;
  const total = queue.items.length;
  elements.progressText.textContent = `${confirmed} / ${total}`;
  elements.progressBar.style.width = `${total ? Math.round((confirmed / total) * 100) : 0}%`;
}

function renderActiveItem() {
  applyItemToForm(getCurrentItem());
  renderQueueList();
  renderProgress();
  elements.prevItem.disabled = activeIndex === 0;
  elements.nextItem.disabled = activeIndex === queue.items.length - 1;
}

function exportPayload() {
  return {
    queue_id: queue.queue_id,
    queue_title: queue.title,
    reviewer_id: elements.reviewerName.value.trim(),
    reviewer_device_id: currentReviewerDeviceId(),
    exported_at: new Date().toISOString(),
    submissions: Object.values(submissions).sort((a, b) =>
      a.queue_item_id.localeCompare(b.queue_item_id)
    ),
  };
}

function downloadJson() {
  saveCurrent("draft");
  const payload = exportPayload();
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${queue.queue_id}-review-submissions.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function openGitHubIssue() {
  saveCurrent("draft");
  const repo = elements.githubRepo.value.trim();
  if (!repo || !repo.includes("/")) {
    alert("請先填 GitHub Repo，格式為 owner/repo。");
    return;
  }

  const payload = exportPayload();
  const confirmed = payload.submissions.filter(
    (submission) => submission.review_status === "confirmed"
  ).length;
  const json = JSON.stringify(payload, null, 2);
  const includeJson = json.length < 6000;
  const body = [
    `Reviewer: ${payload.reviewer_id || "(未填)"}`,
    `Queue: ${queue.title}`,
    `Confirmed chunks: ${confirmed} / ${queue.items.length}`,
    `Exported at: ${payload.exported_at}`,
    "",
    includeJson
      ? `\`\`\`json\n${json}\n\`\`\``
      : "JSON 內容較長，請先按「匯出 JSON」下載檔案，然後附加到此 issue。",
  ].join("\n");
  const title = `Review submissions: ${queue.title}`;
  const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function move(delta, options = {}) {
  if (options.saveDraft !== false) saveCurrent("draft");
  activeIndex = Math.min(queue.items.length - 1, Math.max(0, activeIndex + delta));
  renderActiveItem();
}

async function init() {
  queue = await fetch(queueUrl).then((response) => response.json());
  elements.queueMeta.textContent = `${queue.title}｜${queue.description}`;
  setupOptions();
  loadProfile();
  loadSubmissions();
  await loadQueueManifest();
  renderTaskList();
  renderActiveItem();

  elements.reviewerDialogForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const reviewerName = elements.reviewerDialogName.value.trim();
    if (!reviewerName) {
      elements.reviewerDialogName.value = "";
      elements.reviewerDialogName.reportValidity();
      return;
    }
    elements.reviewerName.value = reviewerName;
    saveProfile();
    elements.reviewerDialog.close();
  });
  elements.reviewerDialog.addEventListener("cancel", (event) => event.preventDefault());
  elements.reviewerName.addEventListener("change", saveProfile);
  elements.githubRepo.addEventListener("change", saveProfile);
  elements.groupByCouncilor.addEventListener("click", () => {
    taskGroupMode = "councilor";
    renderTaskList();
  });
  elements.groupByYear.addEventListener("click", () => {
    taskGroupMode = "year";
    renderTaskList();
  });
  elements.evidenceRole.addEventListener("change", updateEvidenceRoleHelp);
  elements.questionQualityScore.addEventListener("change", updateQuestionQualityHelp);
  elements.replayEvidence.addEventListener("click", () =>
    renderEvidencePlayer(getCurrentItem(), { autoplay: true })
  );
  elements.contextEvidence.addEventListener("click", () =>
    renderEvidencePlayer(getCurrentItem(), { startOffset: -5, endOffset: 5, autoplay: true })
  );
  elements.prevItem.addEventListener("click", () => move(-1));
  elements.nextItem.addEventListener("click", () => move(1));
  elements.skipItem.addEventListener("click", () => move(1));
  elements.saveDraft.addEventListener("click", () => saveCurrent("draft"));
  elements.confirmItem.addEventListener("click", () => {
    saveCurrent("confirmed");
    if (activeIndex < queue.items.length - 1) move(1, { saveDraft: false });
    else renderActiveItem();
  });
  elements.exportJson.addEventListener("click", downloadJson);
  elements.openIssue.addEventListener("click", openGitHubIssue);
  ensureReviewerIdentity();
}

init().catch((error) => {
  console.error(error);
  elements.queueMeta.textContent = "校正任務載入失敗，請確認 review_queue.json 是否存在。";
});
