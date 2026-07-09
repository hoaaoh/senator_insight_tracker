const data = window.MVP_DATA;
const pledgeData = window.MVP_PLEDGES_2022 || [];
const actionData = window.MVP_ACTIONS_REAL || [];
const actionEvidenceData = window.MVP_ACTION_EVIDENCE || [];

const state = {
  month: data.months[data.months.length - 1],
  repId: "all",
  issueId: "all",
  timelineUnit: "month"
};

const monthSelect = document.querySelector("#monthSelect");
const repSelect = document.querySelector("#repSelect");
const issueSelect = document.querySelector("#issueSelect");
const resetFilters = document.querySelector("#resetFilters");
const timelineUnit = document.querySelector("#timelineUnit");
const heatmap = document.querySelector("#heatmap");
const timeline = document.querySelector("#timeline");
const pledgePanel = document.querySelector("#pledgePanel");
const trendChart = document.querySelector("#trendChart");

function formatMonth(month) {
  const [year, value] = month.split("-");
  return `${year}/${value}`;
}

function formatDate(date) {
  return date.replaceAll("-", "/");
}

function getIssue(issueId) {
  return data.issues.find((issue) => issue.id === issueId);
}

function getRep(repId) {
  return data.representatives.find((rep) => rep.id === repId);
}

function getNormalizedPledges() {
  return pledgeData.length
    ? pledgeData.map((pledge) => ({
        repId: pledge.representative_id,
        issueId: pledge.issue_id,
        text: pledge.pledge_summary,
        sourcePdf: pledge.source_pdf,
        sourcePage: pledge.source_page,
        sourceCrop: pledge.source_crop,
        reviewStatus: pledge.review_status
      }))
    : data.pledges;
}

function getActions() {
  return actionData.length
    ? actionData.map((action) => ({
        id: action.action_id,
        repId: action.representative_id,
        date: action.action_date,
        issueId: action.issue_id,
        type: action.action_type,
        title: action.title,
        alignment: action.alignment || "無法判斷",
        weight: Number(action.weight || 0),
        summary: action.summary,
        sourceId: action.source_id,
        source: action.source_name || action.source_id || "待補來源",
        url: action.source_url || "#",
        sourceFile: action.source_file,
        reviewStatus: action.review_status
      }))
    : data.actions;
}

function getActionEvidence(actionId) {
  return actionEvidenceData
    .filter((evidence) => evidence.action_id === actionId)
    .map((evidence) => ({
      role: evidence.evidence_role,
      summary: evidence.evidence_summary,
      url: evidence.source_url,
      frame: evidence.evidence_frame,
      status: evidence.review_status,
      start: Number(evidence.start_seconds || 0),
      end: Number(evidence.end_seconds || 0)
    }));
}

function formatTimecode(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":");
}

function renderActionEvidence(actionId) {
  const evidenceRows = getActionEvidence(actionId);
  if (!evidenceRows.length) return "";

  return `
    <details class="event-evidence">
      <summary>影片證據 ${evidenceRows.length} 段</summary>
      <div class="evidence-items">
        ${evidenceRows
          .map((evidence) => {
            const source = evidence.url
              ? `<a class="source-link compact" href="${evidence.url}">${formatTimecode(evidence.start)}</a>`
              : `<span class="source-note compact">${formatTimecode(evidence.start)}</span>`;
            const frame = evidence.frame
              ? `<a class="source-link compact" href="${evidence.frame}">影格</a>`
              : "";
            return `
              <div class="evidence-item">
                <span class="tag">${evidence.role}</span>
                <p>${evidence.summary} ${source} ${frame}</p>
              </div>
            `;
          })
          .join("")}
      </div>
    </details>
  `;
}

function getOpinion(month, issueId) {
  return data.publicOpinion.find(
    (item) => item.month === month && item.issueId === issueId
  );
}

function monthOf(date) {
  return date.slice(0, 7);
}

function dayOf(date) {
  return date.slice(8, 10);
}

function daysInMonth(month) {
  const [year, value] = month.split("-").map(Number);
  return new Date(year, value, 0).getDate();
}

function matchesFilters(item, includeMonth = true) {
  const monthMatch = !includeMonth || monthOf(item.date) === state.month;
  const repMatch = state.repId === "all" || item.repId === state.repId;
  const issueMatch = state.issueId === "all" || item.issueId === state.issueId;
  return monthMatch && repMatch && issueMatch;
}

function matchesScope(item) {
  const repMatch = state.repId === "all" || item.repId === state.repId;
  const issueMatch = state.issueId === "all" || item.issueId === state.issueId;
  return repMatch && issueMatch;
}

function actionScore(repId, issueId, month) {
  return getActions()
    .filter(
      (action) =>
        action.repId === repId &&
        action.issueId === issueId &&
        monthOf(action.date) === month
    )
    .reduce((sum, action) => sum + action.weight * 12, 0);
}

function responseScore(repId, issueId, month) {
  const opinion = getOpinion(month, issueId);
  const actions = actionScore(repId, issueId, month);
  if (!opinion) return 0;
  return Math.min(100, Math.round((actions / Math.max(45, opinion.volume)) * 100));
}

function pledgeAttention(repId, issueId) {
  const pledges = getNormalizedPledges().filter((pledge) => pledge.repId === repId);
  const issuePledges = pledges.filter((pledge) => pledge.issueId === issueId);
  const share = pledges.length ? issuePledges.length / pledges.length : 0;
  return {
    count: issuePledges.length,
    total: pledges.length,
    percent: Math.round(share * 100)
  };
}

function hasConflict(repId, issueId, month) {
  return getActions().some(
    (action) =>
      action.repId === repId &&
      action.issueId === issueId &&
      monthOf(action.date) === month &&
      action.alignment === "衝突"
  );
}

function heatColor(score, conflict) {
  if (conflict) return "#c8bff0";
  if (score >= 78) return "#77bf91";
  if (score >= 45) return "#f2d27b";
  return "#f2b7ac";
}

function alignmentClass(alignment) {
  if (alignment === "符合") return "good";
  if (alignment === "部分符合") return "mixed";
  if (alignment === "衝突") return "conflict";
  return "";
}

function reviewLabel(status) {
  if (status === "verified") return "已查證";
  if (status === "rejected") return "已排除";
  if (status === "needs_review") return "待查證";
  return "";
}

function isDemoAction(action) {
  return action.sourceId === "mvp-seed-demo";
}

function updateResetControl() {
  const filtered = state.repId !== "all" || state.issueId !== "all";
  resetFilters.hidden = !filtered;
}

function seedControls() {
  monthSelect.innerHTML = data.months
    .map((month) => `<option value="${month}">${formatMonth(month)}</option>`)
    .join("");
  monthSelect.value = state.month;

  repSelect.innerHTML = [
    `<option value="all">全部民代</option>`,
    ...data.representatives.map(
      (rep) => `<option value="${rep.id}">${rep.name}</option>`
    )
  ].join("");

  issueSelect.innerHTML = [
    `<option value="all">全部議題</option>`,
    ...data.issues.map(
      (issue) => `<option value="${issue.id}">${issue.label}</option>`
    )
  ].join("");
}

function updateKpis() {
  const opinions = data.publicOpinion.filter((item) => item.month === state.month);
  const selectedOpinions =
    state.issueId === "all"
      ? opinions
      : opinions.filter((item) => item.issueId === state.issueId);
  const hottest = [...selectedOpinions].sort((a, b) => b.volume - a.volume)[0];

  const actionsThisMonth = getActions().filter((action) => matchesFilters(action));
  const aligned = actionsThisMonth.filter((action) =>
    ["符合", "部分符合"].includes(action.alignment)
  ).length;
  const alignmentRate = actionsThisMonth.length
    ? Math.round((aligned / actionsThisMonth.length) * 100)
    : 0;

  const gapCandidates = data.representatives.flatMap((rep) =>
    data.issues.map((issue) => {
      const opinion = getOpinion(state.month, issue.id);
      return {
        rep,
        issue,
        gap: opinion.volume - responseScore(rep.id, issue.id, state.month)
      };
    })
  );
  const filteredGaps = gapCandidates.filter((item) => {
    const repMatch = state.repId === "all" || item.rep.id === state.repId;
    const issueMatch = state.issueId === "all" || item.issue.id === state.issueId;
    return repMatch && issueMatch;
  });
  const biggestGap = filteredGaps.sort((a, b) => b.gap - a.gap)[0];

  document.querySelector("#hotIssue").textContent = hottest
    ? getIssue(hottest.issueId).label
    : "--";
  document.querySelector("#hotIssueMeta").textContent = hottest
    ? `熱度 ${hottest.volume}，情緒 ${hottest.sentiment}/100`
    : "沒有資料";
  document.querySelector("#actionCount").textContent = actionsThisMonth.length;
  document.querySelector("#actionCountMeta").textContent =
    state.repId === "all" ? "所有民代本月行動" : `${getRep(state.repId).name} 本月行動`;
  document.querySelector("#alignmentRate").textContent = `${alignmentRate}%`;
  document.querySelector("#responseGap").textContent = biggestGap
    ? `${biggestGap.gap}`
    : "--";
  document.querySelector("#responseGapMeta").textContent = biggestGap
    ? `${biggestGap.rep.name} / ${biggestGap.issue.label}`
    : "沒有資料";
}

function renderHeatmap() {
  const reps =
    state.repId === "all"
      ? data.representatives
      : data.representatives.filter((rep) => rep.id === state.repId);
  const issues =
    state.issueId === "all"
      ? data.issues
      : data.issues.filter((issue) => issue.id === state.issueId);

  heatmap.style.setProperty("--issue-count", issues.length);
  heatmap.style.setProperty(
    "--heatmap-min-width",
    issues.length > 3 ? "850px" : "0px"
  );
  document.querySelector("#heatmapMonth").textContent = formatMonth(state.month);

  const header = `
    <div class="heatmap-row">
      <div class="heatmap-head"></div>
      ${issues
        .map(
          (issue) => `
            <button
              class="heatmap-head heatmap-issue-head"
              data-issue="${issue.id}"
              type="button"
              aria-label="選擇議題 ${issue.label}"
            >
              ${issue.label}
            </button>
          `
        )
        .join("")}
    </div>
  `;

  const rows = reps
    .map((rep) => {
      const cells = issues
        .map((issue) => {
          const score = responseScore(rep.id, issue.id, state.month);
          const conflict = hasConflict(rep.id, issue.id, state.month);
          const count = getActions().filter(
            (action) =>
              action.repId === rep.id &&
              action.issueId === issue.id &&
              monthOf(action.date) === state.month
          ).length;
          const attention = pledgeAttention(rep.id, issue.id);
          return `
            <button
              class="heatmap-cell"
              type="button"
              style="background:${heatColor(score, conflict)}"
              data-rep="${rep.id}"
              data-issue="${issue.id}"
              aria-label="${rep.name} ${issue.label} 回應度 ${score}，政見關注比重 ${attention.percent}%"
            >
              <strong>${score}</strong>
              <span>${count} 筆行動</span>
              <span class="pledge-meter" title="政見關注比重 ${attention.count}/${attention.total}">
                <span style="width:${attention.percent}%"></span>
              </span>
              <span class="pledge-attention">政見 ${attention.percent}%</span>
            </button>
          `;
        })
        .join("");
      return `
        <div class="heatmap-row">
          <div class="heatmap-label">${rep.name}</div>
          ${cells}
        </div>
      `;
    })
    .join("");

  heatmap.innerHTML = header + rows;
  heatmap.querySelectorAll(".heatmap-issue-head").forEach((head) => {
    head.addEventListener("click", () => {
      state.repId = "all";
      state.issueId = head.dataset.issue;
      repSelect.value = state.repId;
      issueSelect.value = state.issueId;
      render();
    });
  });
  heatmap.querySelectorAll(".heatmap-cell").forEach((cell) => {
    cell.addEventListener("click", () => {
      state.repId = cell.dataset.rep;
      state.issueId = cell.dataset.issue;
      repSelect.value = state.repId;
      issueSelect.value = state.issueId;
      render();
    });
  });
}

function renderTrend() {
  const issueId = state.issueId === "all" ? hottestIssueId() : state.issueId;
  const issue = getIssue(issueId);
  const values = data.months.map((month) => getOpinion(month, issueId).volume);
  const sentiments = data.months.map((month) => getOpinion(month, issueId).sentiment);
  const max = Math.max(...values, 100);
  const points = values.map((value, index) => {
    const x = 36 + index * ((520 - 72) / (values.length - 1));
    const y = 190 - (value / max) * 154;
    return { x, y, value };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");

  document.querySelector("#trendIssue").textContent = issue.label;
  trendChart.innerHTML = `
    <svg class="trend-svg" viewBox="0 0 520 220" role="img">
      <line x1="36" y1="190" x2="500" y2="190" stroke="#d9dfda" />
      <line x1="36" y1="34" x2="36" y2="190" stroke="#d9dfda" />
      ${points
        .map((point, index) => {
          const height = 190 - point.y;
          const tone = sentiments[index] < 36 ? "#c95047" : sentiments[index] < 43 ? "#c98921" : "#167c80";
          return `<rect x="${point.x - 10}" y="${point.y}" width="20" height="${height}" rx="4" fill="${tone}" opacity="0.28"></rect>`;
        })
        .join("")}
      <polyline points="${line}" fill="none" stroke="#365c91" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
      ${points
        .map(
          (point) =>
            `<circle cx="${point.x}" cy="${point.y}" r="5" fill="#ffffff" stroke="#365c91" stroke-width="3"><title>熱度 ${point.value}</title></circle>`
        )
        .join("")}
    </svg>
    <div class="trend-axis">
      ${data.months.map((month) => `<span>${month.slice(5)}</span>`).join("")}
    </div>
  `;
}

function hottestIssueId() {
  return [...data.publicOpinion]
    .filter((item) => item.month === state.month)
    .sort((a, b) => b.volume - a.volume)[0].issueId;
}

function renderTimeline() {
  const periods =
    state.timelineUnit === "month"
      ? data.months.map((month) => ({ key: month, label: month.slice(5) }))
      : Array.from({ length: daysInMonth(state.month) }, (_, index) => {
          const day = String(index + 1).padStart(2, "0");
          return { key: `${state.month}-${day}`, label: String(index + 1) };
        });

  const points = periods.map((period) => {
    const actions = getActions().filter((action) => {
      const periodMatch =
        state.timelineUnit === "month"
          ? monthOf(action.date) === period.key
          : action.date === period.key;
      return periodMatch && matchesScope(action);
    });
    return {
      ...period,
      actions,
      value: actions.reduce((sum, action) => sum + action.weight * 10, 0)
    };
  });

  const max = Math.max(...points.map((point) => point.value), 50);
  const chartPoints = points.map((point, index) => {
    const x = 46 + index * ((620 - 92) / Math.max(1, points.length - 1));
    const y = 238 - (point.value / max) * 176;
    return { ...point, x, y };
  });
  const line = chartPoints.map((point) => `${point.x},${point.y}`).join(" ");
  const totalIndex = points.reduce((sum, point) => sum + point.value, 0);
  const peak = [...points].sort((a, b) => b.value - a.value)[0];
  const scopeText = [
    state.repId === "all" ? "全部民代" : getRep(state.repId).name,
    state.issueId === "all" ? "全部議題" : getIssue(state.issueId).label,
    state.timelineUnit === "month" ? "月指數" : `${formatMonth(state.month)} 日指數`
  ].join(" / ");

  const evidenceActions = getActions()
    .filter((action) => monthOf(action.date) === state.month && matchesScope(action))
    .sort((a, b) => b.date.localeCompare(a.date));

  timeline.innerHTML = `
    <div class="timeline-chart">
      <svg class="timeline-svg" viewBox="0 0 640 318" role="img" aria-label="${scopeText}">
        <line x1="46" y1="238" x2="604" y2="238" stroke="#d9dfda" />
        <line x1="46" y1="62" x2="46" y2="238" stroke="#d9dfda" />
        <text x="16" y="68" fill="#66716d" font-size="12">${max}</text>
        <text x="22" y="242" fill="#66716d" font-size="12">0</text>
        ${chartPoints
          .map((point) => {
            const height = 238 - point.y;
            return `<rect x="${point.x - 8}" y="${point.y}" width="16" height="${height}" rx="4" fill="#167c80" opacity="0.16"></rect>`;
          })
          .join("")}
        <polyline points="${line}" fill="none" stroke="#365c91" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
        ${chartPoints
          .map(
            (point) =>
              `<circle cx="${point.x}" cy="${point.y}" r="5" fill="#ffffff" stroke="#365c91" stroke-width="3"><title>${point.key} 行動指數 ${point.value}</title></circle>`
          )
          .join("")}
        ${chartPoints
          .map((point, index) => {
            const showDayLabel =
              state.timelineUnit === "month" ||
              index === 0 ||
              index === chartPoints.length - 1 ||
              Number(point.label) % 5 === 0;
            return showDayLabel
              ? `<text x="${point.x}" y="286" text-anchor="middle" fill="#66716d" font-size="12">${point.label}</text>`
              : "";
          })
          .join("")}
      </svg>
      <div class="timeline-summary">
        <span class="tag">${scopeText}</span>
        <span class="tag good">總行動指數 ${totalIndex}</span>
        <span class="tag mixed">高峰 ${peak.label}：${peak.value}</span>
      </div>
    </div>
    <div class="evidence-list">
      ${
        evidenceActions.length
          ? evidenceActions
              .map(
                (action) => {
                  const review = reviewLabel(action.reviewStatus);
                  const source = action.url && action.url !== "#"
                    ? `<a class="source-link" href="${action.url}">${action.source}</a>`
                    : `<span class="source-note">${action.source}</span>`;
                  return `
                    <article class="event">
                      <div class="event-date">${formatDate(action.date)}</div>
                      <div class="event-body">
                        <div class="event-title">${action.title}</div>
                        <div class="event-meta">
                          <span class="tag">${action.type}</span>
                          <span class="tag">${getRep(action.repId).name}</span>
                          <span class="tag">${getIssue(action.issueId).label}</span>
                          <span class="tag good">+${action.weight * 10}</span>
                          <span class="tag ${alignmentClass(action.alignment)}">${action.alignment}</span>
                          ${isDemoAction(action) ? `<span class="tag demo">Demo</span>` : ""}
                          ${review ? `<span class="tag mixed">${review}</span>` : ""}
                        </div>
                        <p class="event-summary">${action.summary} ${source}</p>
                        ${renderActionEvidence(action.id)}
                      </div>
                    </article>
                  `;
                }
              )
              .join("")
          : `<div class="empty-state">這個範圍目前沒有行動紀錄，曲線會維持在 0。</div>`
      }
    </div>
  `;
}

function renderPledges() {
  const reps =
    state.repId === "all"
      ? data.representatives
      : data.representatives.filter((rep) => rep.id === state.repId);
  const pledges = getNormalizedPledges().filter((pledge) => {
    const repMatch = reps.some((rep) => rep.id === pledge.repId);
    const issueMatch = state.issueId === "all" || pledge.issueId === state.issueId;
    return repMatch && issueMatch;
  });

  if (!pledges.length) {
    pledgePanel.innerHTML = `<div class="empty-state">目前沒有符合條件的政見資料。</div>`;
    return;
  }

  pledgePanel.innerHTML = pledges
    .map((pledge) => {
      const rep = getRep(pledge.repId);
      const issue = getIssue(pledge.issueId);
      const relatedActions = getActions().filter(
        (action) =>
          action.repId === pledge.repId &&
          action.issueId === pledge.issueId &&
          monthOf(action.date) === state.month
      );
      const conflicts = relatedActions.filter((action) => action.alignment === "衝突").length;
      const label = relatedActions.length
        ? conflicts
          ? "有衝突"
          : "本月有行動"
        : "本月無行動";
      const tagClass = conflicts ? "conflict" : relatedActions.length ? "good" : "mixed";
      const sourceLink = pledge.sourceCrop
        ? `<a class="source-link" href="${pledge.sourceCrop}">公報裁切圖</a>`
        : "";
      const pdfLink = pledge.sourcePdf
        ? `<a class="source-link" href="${pledge.sourcePdf}">官方公報 PDF p.${pledge.sourcePage}</a>`
        : "";
      const reviewTag =
        pledge.reviewStatus === "needs_review"
          ? `<span class="tag mixed">待校對</span>`
          : "";

      return `
        <article class="pledge-block">
          <div class="pledge-heading">
            <span>${rep.name} / ${issue.label}</span>
            <span class="tag ${tagClass}">${label}</span>
          </div>
          <p class="pledge-copy">${pledge.text}</p>
          <div class="event-meta">
            <span class="tag">2022 選舉公報</span>
            ${reviewTag}
          </div>
          <p class="event-summary">${rep.party}，${rep.district} ${pdfLink} ${sourceLink}</p>
        </article>
      `;
    })
    .join("");
}

function render() {
  monthSelect.value = state.month;
  repSelect.value = state.repId;
  issueSelect.value = state.issueId;
  timelineUnit.value = state.timelineUnit;
  updateResetControl();
  updateKpis();
  renderHeatmap();
  renderTrend();
  renderTimeline();
  renderPledges();
}

seedControls();
render();

monthSelect.addEventListener("change", (event) => {
  state.month = event.target.value;
  render();
});

repSelect.addEventListener("change", (event) => {
  state.repId = event.target.value;
  render();
});

issueSelect.addEventListener("change", (event) => {
  state.issueId = event.target.value;
  render();
});

timelineUnit.addEventListener("change", (event) => {
  state.timelineUnit = event.target.value;
  render();
});

resetFilters.addEventListener("click", () => {
  state.repId = "all";
  state.issueId = "all";
  render();
});
