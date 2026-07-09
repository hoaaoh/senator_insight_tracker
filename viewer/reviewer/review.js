const queueUrl = "./review_queue.json";
const data = window.MVP_DATA || { representatives: [], issues: [] };
const storageVersion = "v2";

const speakerOptions = [
  ...data.representatives.map((rep) => ({ id: rep.id, label: rep.name })),
  { id: "official", label: "官員答覆" },
  { id: "chair", label: "主席/議事人員" },
  { id: "not_target", label: "非目標選區議員" },
  { id: "unknown", label: "不確定" },
];

let queue = null;
let activeIndex = 0;
let submissions = {};

const elements = {
  queueMeta: document.querySelector("#queueMeta"),
  queueList: document.querySelector("#queueList"),
  progressText: document.querySelector("#progressText"),
  progressBar: document.querySelector("#progressBar"),
  reviewerName: document.querySelector("#reviewerName"),
  githubRepo: document.querySelector("#githubRepo"),
  itemTitle: document.querySelector("#itemTitle"),
  itemCounter: document.querySelector("#itemCounter"),
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
  correctedText: document.querySelector("#correctedText"),
  reviewNotes: document.querySelector("#reviewNotes"),
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

function storageKey() {
  return `review-submissions:${storageVersion}:${queue.queue_id}`;
}

function reviewerKey() {
  return `reviewer-profile:${storageVersion}`;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":");
}

function defaultRepo() {
  const host = window.location.hostname;
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (host.endsWith(".github.io") && parts.length) {
    return `${host.replace(".github.io", "")}/${parts[0]}`;
  }
  return "";
}

function loadProfile() {
  const profile = JSON.parse(localStorage.getItem(reviewerKey()) || "{}");
  elements.reviewerName.value = profile.reviewer_name || "";
  elements.githubRepo.value = profile.github_repo || defaultRepo();
}

function saveProfile() {
  localStorage.setItem(
    reviewerKey(),
    JSON.stringify({
      reviewer_name: elements.reviewerName.value.trim(),
      github_repo: elements.githubRepo.value.trim(),
    })
  );
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
    start_seconds: item.start_seconds,
    end_seconds: item.end_seconds,
    reviewer_id: elements.reviewerName.value.trim(),
    include_status: elements.includeStatus.value,
    speaker_id: elements.speakerId.value,
    speaker_confidence: elements.speakerConfidence.value,
    primary_issue: elements.primaryIssue.value,
    secondary_issues: secondaryIssues,
    action_type: elements.actionType.value,
    action_intent: elements.actionIntent.value.trim(),
    evidence_role: elements.evidenceRole.value,
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
  elements.evidenceFrame.src = item.evidence_frame || "";
  elements.evidenceFrame.hidden = !item.evidence_frame;
  elements.frameCaption.textContent = item.evidence_frame ? "人工確認影格" : "無影格";
  elements.sourceLink.href = item.source_url;
  elements.timeRange.textContent = `${formatTime(item.start_seconds)} - ${formatTime(item.end_seconds)}`;
  elements.suggestedSpeaker.textContent = item.representative_name || "--";
  elements.suggestedIssue.textContent = item.suggested_primary_issue_label || "--";
  elements.suggestedRole.textContent = item.suggested_evidence_role || "--";
  elements.asrText.textContent = item.asr_text || "沒有 ASR 文字";

  elements.includeStatus.value = draft?.include_status || "include";
  elements.speakerId.value = speakerId;
  elements.speakerConfidence.value = draft?.speaker_confidence || "confirmed";
  elements.primaryIssue.value = draft?.primary_issue || item.suggested_primary_issue || "transport";
  elements.actionType.value = draft?.action_type || "質詢";
  elements.actionIntent.value = draft?.action_intent || item.suggested_summary || "";
  elements.evidenceRole.value = draft?.evidence_role || item.suggested_evidence_role || "detail";
  elements.correctedText.value = draft?.corrected_text || item.asr_text || "";
  elements.reviewNotes.value = draft?.notes || item.suggested_notes || "";
  updateEvidenceRoleHelp();

  const secondaryIssues = new Set(draft?.secondary_issues || []);
  elements.secondaryIssues.querySelectorAll("input").forEach((input) => {
    input.checked = secondaryIssues.has(input.value);
  });
}

function updateEvidenceRoleHelp() {
  elements.evidenceRoleHelp.textContent =
    evidenceRoleDescriptions[elements.evidenceRole.value] || "";
}

function renderQueueList() {
  elements.queueList.innerHTML = queue.items
    .map((item, index) => {
      const draft = getDraft(item);
      const status = draft?.review_status === "confirmed" ? "done" : draft ? "draft" : "new";
      return `
        <button class="queue-item ${index === activeIndex ? "active" : ""} ${status === "done" ? "done" : ""}" type="button" data-index="${index}">
          <strong>${String(index + 1).padStart(2, "0")} ${item.suggested_evidence_role}</strong>
          <small>${formatTime(item.start_seconds)} / ${status}</small>
        </button>
      `;
    })
    .join("");

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
  renderActiveItem();

  elements.reviewerName.addEventListener("change", saveProfile);
  elements.githubRepo.addEventListener("change", saveProfile);
  elements.evidenceRole.addEventListener("change", updateEvidenceRoleHelp);
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
}

init().catch((error) => {
  console.error(error);
  elements.queueMeta.textContent = "校正任務載入失敗，請確認 review_queue.json 是否存在。";
});
