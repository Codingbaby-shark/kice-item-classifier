/* Global State */
const state = {
  frameworksData: null,
  currentSubjectId: "math",
  currentCurriculumId: "2015", // Auto-derived from currentGradeId ('grade3' -> '2015', 'grade1'/'grade2' -> '2022')
  currentGradeId: "grade3",
  selectedElective: "미적분",
  activeElectiveView: "미적분",
  currentProvider: "codex", // 'gemini', 'openai', 'anthropic', 'web_bridge', 'codex', 'claude'
  cliSessions: {
    codex: { installed: false, logged_in: false, auth_source: "" },
    claude: { installed: false, logged_in: false, auth_source: "" },
  },
  envKeys: {
    gemini: false,
    openai: false,
    anthropic: false,
  },
  samples: [],
  attachments: [], // { name, mime_type, data_base64, page_text, section_name }
  currentReport: null,
  history: [],
  editingItemIndex: null,
  isConvertingFiles: false,
};

const BUILTIN_SUBJECT_IDS = new Set(["math", "korean", "english", "social", "science"]);

const SOCIAL_15_ELECTIVES = [
  "사회·문화",
  "생활과 윤리",
  "윤리와 사상",
  "한국지리",
  "세계지리",
  "동아시아사",
  "세계사",
  "경제",
  "정치와 법",
];

const SCIENCE_15_ELECTIVES = [
  "생명과학Ⅰ",
  "지구과학Ⅰ",
  "화학Ⅰ",
  "물리학Ⅰ",
  "생명과학Ⅱ",
  "지구과학Ⅱ",
  "화학Ⅱ",
  "물리학Ⅱ",
];

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

/* Utility Helpers */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanBehaviorLabel(name) {
  if (!name) return "기타";
  return String(name).split("(")[0].trim() || String(name).trim();
}

function getVisitorId() {
  try {
    let vid = localStorage.getItem("kice_vid");
    if (!vid) {
      vid = "u_" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem("kice_vid", vid);
    }
    return vid;
  } catch (_) {
    return "u_anon";
  }
}

function trackUsage(eventName, extra = {}) {
  try {
    const gradeLabel =
      state.currentGradeId === "grade3"
        ? "고3·N수 (2015 개정)"
        : state.currentGradeId === "grade2"
        ? "고2 (2022 개정)"
        : "고1 (2022 개정)";
    const subjObj = state.frameworksData?.subjects?.[state.currentSubjectId];
    const subjName = subjObj ? subjObj.name : state.currentSubjectId;
    const electivePart =
      state.currentCurriculumId === "2015" && state.selectedElective
        ? ` (${state.selectedElective})`
        : "";

    const payload = {
      vid: getVisitorId(),
      event: eventName,
      grade_curriculum: extra.grade_curriculum || gradeLabel,
      subject: extra.subject || `${subjName}${electivePart}`,
      exam_title:
        extra.exam_title ||
        document.getElementById("examTitleInput")?.value?.trim() ||
        state.currentReport?.exam_title ||
        "",
      item_count:
        extra.item_count !== undefined
          ? extra.item_count
          : state.currentReport?.items?.length || "",
      provider: extra.provider || state.currentProvider || "",
      detail: extra.detail || "",
    };

    fetch("/api/t", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}

function showAlert(msg, type = "info") {
  const banner = document.getElementById("alertBanner");
  const msgEl = document.getElementById("alertMessage");
  if (!banner || !msgEl) return;
  banner.className = `alert-banner no-print ${type}`;
  msgEl.textContent = msg;
  banner.classList.remove("hidden");
}

function hideAlert() {
  const banner = document.getElementById("alertBanner");
  if (banner) banner.classList.add("hidden");
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
  triggerMathRender();
}

function deriveCurriculumFromGrade(gradeId) {
  return gradeId === "grade3" ? "2015" : "2022";
}

function updateAutoCurriculumBadge() {
  state.currentCurriculumId = deriveCurriculumFromGrade(state.currentGradeId);
  const badge = document.getElementById("autoCurriculumBadge");
  if (badge) {
    badge.textContent = state.currentCurriculumId === "2015" ? "2015 개정" : "2022 개정";
  }
}

window.setRangeChip = function (val) {
  const input = document.getElementById("targetRangeInput");
  if (input) {
    input.value = val;
  }
};

window.selectElectiveFullSet = function (electiveVal) {
  state.selectedElective = electiveVal;
  const sel = document.getElementById("electiveSelect");
  if (sel) sel.value = electiveVal;

  const input = document.getElementById("targetRangeInput");
  if (input) {
    if (electiveVal === "ALL_ELECTIVES") {
      input.value = "";
    } else if (state.currentSubjectId === "korean") {
      input.value = `공통과목(1~34번) + 선택과목 ${electiveVal}(35~45번) 총 45문항·100점 풀세트`;
    } else if (state.currentSubjectId === "math") {
      input.value = `공통과목(1~22번) + 선택과목 ${electiveVal}(23~30번) 총 30문항·100점 풀세트`;
    } else if (state.currentSubjectId === "social" || state.currentSubjectId === "science") {
      input.value = `선택과목 [${electiveVal}] 1~20번 (20문항 · 50점 만점 풀세트)`;
    }
  }

  if (electiveVal !== "ALL_ELECTIVES") {
    state.activeElectiveView = electiveVal;
    if (state.currentReport) {
      renderDashboardView();
      populateItemFilters();
      renderItemsView();
    }
  }
  renderActiveFrameworkBanner();
  renderFrameworkEditor();
};

function syncElectiveDropdownOptions() {
  const group = document.getElementById("electiveControlGroup");
  const labelEl = document.getElementById("electiveSelectLabel");
  const sel = document.getElementById("electiveSelect");
  const chipsContainer = document.getElementById("quickElectiveChips");
  if (!group || !sel) return;

  if (state.currentCurriculumId !== "2015") {
    group.classList.add("hidden");
    if (chipsContainer) {
      chipsContainer.innerHTML = `
        <button type="button" class="chip-btn" onclick="setRangeChip('')">전체 문항 자동 분석</button>
        <button type="button" class="chip-btn" onclick="setRangeChip('1번~15번')">1~15번만</button>
        <button type="button" class="chip-btn" onclick="setRangeChip('1번~20번')">1~20번만</button>
      `;
    }
    return;
  }

  if (state.currentSubjectId === "math") {
    group.classList.remove("hidden");
    if (labelEl) labelEl.textContent = "수학 선택과목 풀세트 (30문항·100점)";
    const opts = [
      { value: "미적분", label: "📐 공통 + 미적분 풀세트 (30문항 · 100점)" },
      { value: "확률과 통계", label: "📊 공통 + 확률과 통계 풀세트 (30문항 · 100점)" },
      { value: "기하", label: "📏 공통 + 기하 풀세트 (30문항 · 100점)" },
      { value: "ALL_ELECTIVES", label: "🔄 3개 선택과목 모두 분석 (과목별 탭 전환)" },
    ];
    sel.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    if (!opts.some((o) => o.value === state.selectedElective)) {
      state.selectedElective = "미적분";
    }
    sel.value = state.selectedElective;
    if (chipsContainer) {
      chipsContainer.innerHTML = `
        <button type="button" class="chip-btn" onclick="selectElectiveFullSet('미적분')">📐 공통+미적분 (30문항·100점)</button>
        <button type="button" class="chip-btn" onclick="selectElectiveFullSet('확률과 통계')">📊 공통+확통 (30문항·100점)</button>
        <button type="button" class="chip-btn" onclick="selectElectiveFullSet('기하')">📏 공통+기하 (30문항·100점)</button>
        <button type="button" class="chip-btn" onclick="selectElectiveFullSet('ALL_ELECTIVES')">🔄 3개 선택과목 모두 분석</button>
        <button type="button" class="chip-btn" onclick="setRangeChip('공통과목 1번~22번')">공통만 (1~22번)</button>
      `;
    }
  } else if (state.currentSubjectId === "korean") {
    group.classList.remove("hidden");
    if (labelEl) labelEl.textContent = "국어 선택과목 풀세트 (45문항·100점)";
    const opts = [
      { value: "화법과 작문", label: "🗣️ 공통 + 화법과 작문 풀세트 (45문항 · 100점)" },
      { value: "언어와 매체", label: "📖 공통 + 언어와 매체 풀세트 (45문항 · 100점)" },
      { value: "ALL_ELECTIVES", label: "🔄 2개 선택과목 모두 분석 (과목별 탭 전환)" },
    ];
    sel.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    if (!opts.some((o) => o.value === state.selectedElective)) {
      state.selectedElective = "화법과 작문";
    }
    sel.value = state.selectedElective;
    if (chipsContainer) {
      chipsContainer.innerHTML = `
        <button type="button" class="chip-btn" onclick="selectElectiveFullSet('화법과 작문')">🗣️ 공통+화법과 작문 (45문항)</button>
        <button type="button" class="chip-btn" onclick="selectElectiveFullSet('언어와 매체')">📖 공통+언어와 매체 (45문항)</button>
        <button type="button" class="chip-btn" onclick="selectElectiveFullSet('ALL_ELECTIVES')">🔄 2개 선택과목 모두 분석</button>
      `;
    }
  } else if (state.currentSubjectId === "social") {
    group.classList.remove("hidden");
    if (labelEl) labelEl.textContent = "15개정 사회탐구 선택과목 (20문항·50점)";
    const opts = [
      ...SOCIAL_15_ELECTIVES.map((name) => ({
        value: name,
        label: `🌍 ${name} (20문항 · 50점)`,
      })),
      { value: "ALL_ELECTIVES", label: "🔄 사회탐구 9개 과목 전체 통합 평가틀" },
    ];
    sel.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    if (!opts.some((o) => o.value === state.selectedElective)) {
      state.selectedElective = "사회·문화";
    }
    sel.value = state.selectedElective;
    if (chipsContainer) {
      chipsContainer.innerHTML = SOCIAL_15_ELECTIVES.map(
        (name) =>
          `<button type="button" class="chip-btn" onclick="selectElectiveFullSet('${name}')">${name}</button>`
      ).join("");
    }
  } else if (state.currentSubjectId === "science") {
    group.classList.remove("hidden");
    if (labelEl) labelEl.textContent = "15개정 과학탐구 선택과목 (20문항·50점)";
    const opts = [
      ...SCIENCE_15_ELECTIVES.map((name) => ({
        value: name,
        label: `🧬 ${name} (20문항 · 50점)`,
      })),
      { value: "ALL_ELECTIVES", label: "🔄 과학탐구 8개 과목 전체 통합 평가틀" },
    ];
    sel.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    if (!opts.some((o) => o.value === state.selectedElective)) {
      state.selectedElective = "생명과학Ⅰ";
    }
    sel.value = state.selectedElective;
    if (chipsContainer) {
      chipsContainer.innerHTML = SCIENCE_15_ELECTIVES.map(
        (name) =>
          `<button type="button" class="chip-btn" onclick="selectElectiveFullSet('${name}')">${name}</button>`
      ).join("");
    }
  } else {
    group.classList.add("hidden");
    if (chipsContainer) {
      chipsContainer.innerHTML = `<button type="button" class="chip-btn" onclick="setRangeChip('')">전체 문항 분석</button>`;
    }
  }
}

function triggerMathRender() {
  if (window.renderMathInElement) {
    try {
      window.renderMathInElement(document.body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    } catch (e) {
      console.warn("KaTeX render warning:", e);
    }
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* KICE HWP Equation PUA (U+E000..U+E1FF) Decoder for Digital Exam PDFs */
const KICE_PUA_MAP = {
  0xe034: "1", 0xe035: "2", 0xe036: "3", 0xe037: "4", 0xe038: "5",
  0xe039: "6", 0xe03a: "7", 0xe03b: "8", 0xe03c: "9", 0xe03d: "0",
  0xe03e: "(", 0xe03f: ")", 0xe040: ",", 0xe041: "-", 0xe042: ".",
  0xe043: "/", 0xe044: "+", 0xe045: "-", 0xe046: "=", 0xe047: "<",
  0xe048: ">", 0xe049: "∪", 0xe04a: "∩", 0xe04b: "(", 0xe04c: ")",
  0xe04d: "|", 0xe04e: "{", 0xe04f: "}", 0xe050: "√", 0xe052: "∫",
  0xe053: "∑", 0xe055: "×", 0xe057: "±", 0xe05b: "≠", 0xe05c: "≤",
  0xe05d: "≥", 0xe05f: "→", 0xe066: "∈", 0xe069: "⊂", 0xe06c: "∞",
  0xe06f: "⋯", 0xe07a: "α", 0xe07b: "β", 0xe07c: "γ", 0xe07d: "δ",
  0xe081: "θ", 0xe089: "π", 0xe096: "'", 0xe099: "―", 0xe09a: "→",
  0xe09c: " ", 0xe09d: " ", 0xe0b2: "lim", 0xe0b5: "log", 0xe0b6: "ln",
  0xe0b7: "sin", 0xe0b8: "cos", 0xe0b9: "tan", 0xe0fe: "z", 0xe100: "[", 0xe101: "]",
};
for (let i = 0; i < 26; i++) {
  KICE_PUA_MAP[0xe000 + i] = String.fromCharCode(65 + i);
  KICE_PUA_MAP[0xe01a + i] = String.fromCharCode(65 + i);
}
for (let i = 0; i < 25; i++) {
  KICE_PUA_MAP[0xe0e5 + i] = String.fromCharCode(97 + i);
}

function decodeKicePuaText(str) {
  if (!str) return "";
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (KICE_PUA_MAP[code] !== undefined) {
      out += KICE_PUA_MAP[code];
    } else if (code >= 0xe000 && code <= 0xf8ff) {
      out += " ";
    } else {
      out += str[i];
    }
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

function detectPageSectionAndBooklet(decodedText, topHeaderText = "") {
  let booklet = "";
  if (decodedText.includes("홀수형")) booklet = "홀수형";
  else if (decodedText.includes("짝수형")) booklet = "짝수형";

  const cleanedForSection = (topHeaderText || decodedText.slice(0, 350))
    .replace(/\*?\s*확인\s*사항[\s\S]*$/g, "")
    .replace(/이어서[^\n]*선택과목[^\n]*/g, "");

  let section = "공통과목";
  const allElectives = [
    "확률과 통계",
    "미적분",
    "기하",
    "화법과 작문",
    "언어와 매체",
    ...SOCIAL_15_ELECTIVES,
    ...SCIENCE_15_ELECTIVES,
  ];
  for (const elName of allElectives) {
    if (cleanedForSection.includes(elName)) {
      section = elName;
      break;
    }
  }

  return { section, booklet };
}

function reconstructTwoColumnPageText(textContent, pageWidth) {
  const rawItems = (textContent.items || []).filter((it) => it.str && it.str.trim());
  if (rawItems.length === 0) return { fullText: "", topHeaderText: "" };
  const midX = (pageWidth || 600) * 0.49;

  const headerItems = [];
  const leftCol = [];
  const rightCol = [];

  for (const it of rawItems) {
    const x = it.transform ? it.transform[4] : 0;
    const y = it.transform ? it.transform[5] : 0;
    const txt = decodeKicePuaText(it.str);
    if (!txt) continue;
    if (y > 700) {
      headerItems.push({ x, y, txt });
    } else if (x < midX) {
      leftCol.push({ x, y, txt });
    } else {
      rightCol.push({ x, y, txt });
    }
  }

  const sortLines = (arr) => {
    arr.sort((a, b) => (Math.abs(b.y - a.y) > 4 ? b.y - a.y : a.x - b.x));
    const lines = [];
    let currLine = [];
    let lastY = null;
    for (const item of arr) {
      if (lastY === null || Math.abs(lastY - item.y) <= 4.5) {
        currLine.push(item.txt);
      } else {
        lines.push(currLine.join(" "));
        currLine = [item.txt];
      }
      lastY = item.y;
    }
    if (currLine.length > 0) lines.push(currLine.join(" "));
    return lines.join("\n");
  };

  const topHeaderText = sortLines(headerItems);
  const fullText = [topHeaderText, sortLines(leftCol), sortLines(rightCol)]
    .filter(Boolean)
    .join("\n")
    .replace(/이어서\s*,?\s*[「『]?선택과목[^\n]*/g, "");

  return { fullText, topHeaderText };
}

async function extractPdfTextAndImages(file, onPageProgress) {
  if (!window.pdfjsLib) {
    throw new Error("PDF.js 라이브러리가 로드되지 않았습니다. 페이지를 새로고침(Cmd+R) 해주세요.");
  }
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPdfPages = pdf.numPages;

  const pageEntries = [];
  let hasOddBooklet = false;
  let hasEvenBooklet = false;

  for (let p = 1; p <= totalPdfPages; p++) {
    const page = await pdf.getPage(p);
    const viewport1 = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();
    const { fullText: structuredText, topHeaderText } = reconstructTwoColumnPageText(
      textContent,
      viewport1.width
    );
    const { section, booklet } = detectPageSectionAndBooklet(structuredText, topHeaderText);
    if (booklet === "홀수형") hasOddBooklet = true;
    if (booklet === "짝수형") hasEvenBooklet = true;
    pageEntries.push({ p, page, structuredText, section, booklet });
  }

  const filteredEntries =
    hasOddBooklet && hasEvenBooklet
      ? pageEntries.filter((entry) => entry.booklet !== "짝수형")
      : pageEntries;

  const skippedEvenPages = pageEntries.length - filteredEntries.length;
  const textParts = [];
  const pageImages = [];

  for (let idx = 0; idx < filteredEntries.length; idx++) {
    const { p, page, structuredText, section, booklet } = filteredEntries[idx];
    if (onPageProgress) onPageProgress(idx + 1, filteredEntries.length);

    const sectionTag = section ? `[영역/선택과목: ${section}]` : "";
    const formattedPageText = structuredText
      ? `=== [${file.name} - ${p}페이지 ${sectionTag} ${booklet ? `(${booklet})` : ""}] ===\n${structuredText}`
      : "";
    if (formattedPageText) {
      textParts.push(formattedPageText);
    }

    const viewport = page.getViewport({ scale: 1.15 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
    const b64 = dataUrl.split(",")[1];
    if (b64) {
      pageImages.push({
        name: `${p}p_${section}_${file.name.replace(/\.pdf$/i, "")}.jpg`,
        mime_type: "image/jpeg",
        data_base64: b64,
        page_num: p,
        section_name: section,
        booklet_type: booklet,
        page_text: formattedPageText,
      });
    }
  }

  return {
    text: textParts.join("\n\n"),
    pageImages,
    totalPages: totalPdfPages,
    activePages: filteredEntries.length,
    skippedEvenPages,
  };
}

/* Initialization */
document.addEventListener("DOMContentLoaded", async () => {
  initEventListeners();
  initAdminLogMode();

  await Promise.all([
    fetchEnvStatus(),
    fetchFrameworks(),
    fetchSamples(),
    fetchHistory(),
  ]);

  updateAutoCurriculumBadge();
  syncElectiveDropdownOptions();
  loadSavedApiKeyForProvider();

  if (state.history && state.history.length > 0 && state.history[0].report) {
    setReport(state.history[0].report, false);
  } else {
    const mathSample = state.samples.find((s) => s.id === "csat_math_sample");
    if (mathSample && mathSample.preanalyzed) {
      setReport(mathSample.preanalyzed, false);
    }
  }

  trackUsage("웹앱 접속", {
    detail: window.location.pathname + window.location.search,
  });
});

/* Owner-only Admin Log Setup Mode (Only visible when URL contains ?admin=1) */
function initAdminLogMode() {
  const params = new URLSearchParams(window.location.search);
  const isOwnerAdmin = params.get("admin") === "1";
  const floatBtn = document.getElementById("ownerAdminFloatingBtn");
  if (!isOwnerAdmin || !floatBtn) return;

  floatBtn.classList.remove("hidden");
  floatBtn.addEventListener("click", openAdminLogModal);
  document.getElementById("closeAdminLogModalBtn")?.addEventListener("click", closeAdminLogModal);
  document.getElementById("closeAdminLogFooterBtn")?.addEventListener("click", closeAdminLogModal);
  document.getElementById("copyGasCodeBtn")?.addEventListener("click", copyGasScriptCode);
  document.getElementById("saveAndTestWebhookBtn")?.addEventListener("click", saveAndTestWebhook);
  document.getElementById("refreshAdminLogsBtn")?.addEventListener("click", loadAdminLogs);

  openAdminLogModal();
}

async function openAdminLogModal() {
  const modal = document.getElementById("adminLogModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  await loadAdminLogs();
}

function closeAdminLogModal() {
  document.getElementById("adminLogModal")?.classList.add("hidden");
}

async function copyGasScriptCode() {
  const area = document.getElementById("gasScriptCodeArea");
  if (!area) return;
  try {
    await navigator.clipboard.writeText(area.value);
    showAlert("구글 시트 Apps Script 코드가 복사되었습니다! 구글 시트 > 확장 프로그램 > Apps Script에 붙여넣으세요.", "success");
  } catch (_) {
    area.select();
    document.execCommand("copy");
    showAlert("Apps Script 코드가 복사되었습니다!", "success");
  }
}

async function loadAdminLogs() {
  try {
    const res = await fetch("/api/admin/logs");
    const json = await res.json();
    if (!json.ok) return;

    const urlInput = document.getElementById("adminWebhookUrlInput");
    const statusText = document.getElementById("adminWebhookStatusText");
    if (urlInput && json.webhook_url) {
      urlInput.value = json.webhook_url;
    }
    if (statusText) {
      statusText.textContent = json.webhook_url
        ? "✅ 구글 시트 웹앱 URL이 연결되어 있습니다. 모든 사용자 활동이 시트로 실시간 전송됩니다."
        : "ℹ️ 아직 구글 시트 웹앱 URL이 등록되지 않았습니다. 위 1~2단계를 따라 URL을 입력해 주세요 (서버 내부 로그는 자동 기록 중).";
    }

    const tbody = document.getElementById("adminRecentLogsTbody");
    if (tbody) {
      const logs = json.logs || [];
      if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:14px; text-align:center; color:#64748b;">아직 기록된 사용 로그가 없습니다.</td></tr>`;
      } else {
        tbody.innerHTML = logs
          .map(
            (l) => `
            <tr style="border-bottom:1px solid #e2e8f0;">
              <td style="padding:7px 8px; white-space:nowrap;">${escapeHtml(l.timestamp || "")}</td>
              <td style="padding:7px 8px; white-space:nowrap; font-family:monospace;">${escapeHtml(l.visitor_id || "")}</td>
              <td style="padding:7px 8px; font-weight:700; color:#1e40af; white-space:nowrap;">${escapeHtml(l.event || "")}</td>
              <td style="padding:7px 8px;">${escapeHtml(l.grade_curriculum || "")} · ${escapeHtml(l.subject || "")}</td>
              <td style="padding:7px 8px;">${escapeHtml(l.exam_title || "")} ${l.detail ? `<span style="color:#64748b;">(${escapeHtml(l.detail)})</span>` : ""}</td>
              <td style="padding:7px 8px; white-space:nowrap; color:#475569;">${escapeHtml(l.client || "")}</td>
            </tr>
          `
          )
          .join("");
      }
    }
  } catch (err) {
    console.warn(err);
  }
}

async function saveAndTestWebhook() {
  const urlInput = document.getElementById("adminWebhookUrlInput");
  const statusText = document.getElementById("adminWebhookStatusText");
  const webhookUrl = urlInput?.value.trim() || "";
  if (statusText) {
    statusText.textContent = "⏳ 설정을 저장하고 구글 시트로 테스트 행을 전송하는 중입니다...";
  }
  try {
    const res = await fetch("/api/admin/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "test",
        webhook_url: webhookUrl,
      }),
    });
    const json = await res.json();
    if (json.ok) {
      if (webhookUrl && json.test_sent) {
        if (statusText) {
          statusText.textContent = "🎉 저장 및 구글 시트 테스트 전송 성공! 지금 구글 시트를 확인해 보세요.";
        }
        showAlert("구글 시트 연동 및 테스트 행 전송이 완료되었습니다!", "success");
      } else if (!webhookUrl) {
        if (statusText) {
          statusText.textContent = "ℹ️ 구글 시트 웹앱 URL이 비워졌습니다 (서버 내부 로그만 기록됨).";
        }
      } else {
        if (statusText) {
          statusText.textContent = "⚠️ URL은 저장되었으나 테스트 전송에 실패했습니다. Apps Script 웹앱 배포 권한이 '모든 사용자(Anyone)'인지 확인해 주세요.";
        }
      }
      await loadAdminLogs();
    }
  } catch (err) {
    if (statusText) statusText.textContent = `오류: ${err.message}`;
  }
}

function initEventListeners() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("alertCloseBtn")?.addEventListener("click", hideAlert);

  // Grade change -> automatically sets curriculum (고3 -> 2015, 고1/2 -> 2022)
  document.getElementById("gradeSelect")?.addEventListener("change", (e) => {
    state.currentGradeId = e.target.value;
    updateAutoCurriculumBadge();
    syncElectiveDropdownOptions();
    renderActiveFrameworkBanner();
    renderFrameworkEditor();
    if (state.currentReport) {
      renderDashboardView();
    }
  });

  // Subject change
  document.getElementById("subjectSelect")?.addEventListener("change", (e) => {
    state.currentSubjectId = e.target.value;
    syncElectiveDropdownOptions();
    renderActiveFrameworkBanner();
    renderFrameworkEditor();
  });

  // Elective change
  document.getElementById("electiveSelect")?.addEventListener("change", (e) => {
    window.selectElectiveFullSet(e.target.value);
  });

  // Provider change
  document.getElementById("providerSelect")?.addEventListener("change", (e) => {
    state.currentProvider = e.target.value;
    loadSavedApiKeyForProvider();
    updateProviderUiState();
    renderActiveFrameworkBanner();
    if (state.currentProvider === "web_bridge") {
      openWebBridgeModal();
    }
  });

  // API Key Input
  const apiKeyInput = document.getElementById("apiKeyInput");
  apiKeyInput?.addEventListener("input", () => {
    const storageKey = `kice_api_key_${state.currentProvider}`;
    localStorage.setItem(storageKey, apiKeyInput.value.trim());
    updateProviderUiState();
  });

  document.getElementById("toggleApiKeyBtn")?.addEventListener("click", () => {
    const isPwd = apiKeyInput.type === "password";
    apiKeyInput.type = isPwd ? "text" : "password";
    document.getElementById("toggleApiKeyBtn").textContent = isPwd ? "숨김" : "보기";
  });

  // Web Bridge Modal
  document.getElementById("openWebBridgeBtn")?.addEventListener("click", openWebBridgeModal);
  document.getElementById("closeWebBridgeModalBtn")?.addEventListener("click", closeWebBridgeModal);
  document.getElementById("cancelWebBridgeBtn")?.addEventListener("click", closeWebBridgeModal);
  document.getElementById("copyBridgePromptBtn")?.addEventListener("click", copyBridgePromptToClipboard);
  document.getElementById("applyWebBridgeResultBtn")?.addEventListener("click", applyWebBridgeResult);

  // File Upload & Drag-Drop
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");

  dropZone?.addEventListener("click", () => fileInput?.click());
  dropZone?.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone?.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });
  dropZone?.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFilesSelected(Array.from(e.dataTransfer.files));
    }
  });
  fileInput?.addEventListener("change", async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      await handleFilesSelected(Array.from(e.target.files));
      fileInput.value = "";
    }
  });

  document.getElementById("clearAttachmentsBtn")?.addEventListener("click", () => {
    state.attachments = [];
    renderAttachments();
  });

  document.getElementById("clearTextBtn")?.addEventListener("click", () => {
    document.getElementById("rawTextInput").value = "";
  });

  // Sample loaders
  document.querySelectorAll(".sample-load-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sampleId = btn.dataset.sampleId;
      loadSampleIntoInputs(sampleId);
    });
  });

  // Run AI Analysis
  document.getElementById("runAnalyzeBtn")?.addEventListener("click", runAiAnalysis);

  // Import JSON Report
  document.getElementById("importJsonInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      const report = obj.report || obj;
      if (report && Array.isArray(report.items)) {
        setReport(report, true);
        await fetch("/api/history/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ report }),
        }).catch(() => {});
        await fetchHistory();
        showAlert(`'${report.exam_title || file.name}' 리포트를 불러왔습니다.`, "success");
      } else {
        showAlert("유효한 문항 분석 리포트 JSON 형식이 아닙니다.", "error");
      }
    } catch (err) {
      showAlert(`JSON 파일 읽기 오류: ${err.message}`, "error");
    }
    e.target.value = "";
  });

  // Filters in Tab 3
  document.getElementById("itemSearchInput")?.addEventListener("input", renderItemsView);
  document.getElementById("filterMajorSelect")?.addEventListener("change", renderItemsView);
  document.getElementById("filterBehaviorSelect")?.addEventListener("change", renderItemsView);

  // Add / Edit Item Modal
  document.getElementById("addNewItemBtn")?.addEventListener("click", () => openEditModal(-1));
  document.getElementById("closeEditModalBtn")?.addEventListener("click", closeEditModal);
  document.getElementById("cancelEditModalBtn")?.addEventListener("click", closeEditModal);
  document.getElementById("saveEditModalBtn")?.addEventListener("click", saveEditedItem);

  // Framework Editor (Add, Delete, Save)
  document.getElementById("saveFrameworkBtn")?.addEventListener("click", saveCustomFramework);
  document.getElementById("addCustomSubjectBtn")?.addEventListener("click", addNewCustomSubject);
  document.getElementById("deleteCustomSubjectBtn")?.addEventListener("click", deleteCurrentSubject);

  // Export Buttons
  document.getElementById("exportExcelBtn")?.addEventListener("click", exportToExcel);
  document.getElementById("exportCsvBtn")?.addEventListener("click", exportToCsv);
  document.getElementById("exportJsonBtn")?.addEventListener("click", exportToJson);
  document.getElementById("printReportBtn")?.addEventListener("click", () => {
    triggerMathRender();
    trackUsage("인쇄 / PDF 저장", {
      exam_title: state.currentReport?.exam_title || "",
      item_count: state.currentReport?.items?.length || 0,
    });
    window.print();
  });
}

function loadSavedApiKeyForProvider() {
  const apiKeyInput = document.getElementById("apiKeyInput");
  if (!apiKeyInput) return;
  const p = state.currentProvider;
  const saved =
    localStorage.getItem(`kice_api_key_${p}`) ||
    (p === "gemini" ? localStorage.getItem("kice_gemini_api_key") || "" : "");
  apiKeyInput.value = saved;
}

function updateProviderUiState() {
  const provider = state.currentProvider;
  const apiGroup = document.getElementById("apiKeyControlGroup");
  const apiLabel = document.getElementById("apiKeyLabelText");
  const apiInput = document.getElementById("apiKeyInput");
  const badge = document.getElementById("sessionStatusBadge");
  if (!apiGroup || !badge) return;

  if (provider === "gemini" || provider === "openai" || provider === "anthropic") {
    apiGroup.classList.remove("hidden");
    const keyMap = {
      gemini: { label: "Gemini API Key", placeholder: "AIzaSy... (브라우저 저장)" },
      openai: { label: "OpenAI API Key", placeholder: "sk-... (브라우저 저장)" },
      anthropic: { label: "Claude API Key", placeholder: "sk-ant-... (브라우저 저장)" },
    };
    if (apiLabel) apiLabel.textContent = keyMap[provider].label;
    if (apiInput) apiInput.placeholder = keyMap[provider].placeholder;

    const val = apiInput?.value.trim() || "";
    const ready = Boolean(val || state.envKeys?.[provider]);
    badge.className = `session-pill ${ready ? "ready" : ""}`;
    badge.textContent = ready ? "API Key 준비됨" : "API Key 입력 필요";
    document.getElementById("apiKeyStatusBadge")?.classList.toggle("ready", ready);
  } else if (provider === "web_bridge") {
    apiGroup.classList.add("hidden");
    badge.className = "session-pill ready";
    badge.textContent = "웹 브라우저 복붙 모드";
  } else if (provider === "codex") {
    apiGroup.classList.add("hidden");
    const ok = state.cliSessions?.codex?.logged_in;
    badge.className = `session-pill ${ok ? "ready" : ""}`;
    badge.textContent = ok ? "로컬 Codex 연결됨" : "Codex 미설치 (API/웹모드 권장)";
  } else if (provider === "claude") {
    apiGroup.classList.add("hidden");
    const ok = state.cliSessions?.claude?.logged_in;
    badge.className = `session-pill ${ok ? "ready" : ""}`;
    badge.textContent = ok ? "로컬 Claude 연결됨" : "Claude CLI 미설치 (API/웹모드 권장)";
  }
}

async function fetchEnvStatus() {
  try {
    const res = await fetch("/api/env");
    const json = await res.json();
    if (json.ok) {
      if (json.env_keys) state.envKeys = json.env_keys;
      if (json.cli_sessions) state.cliSessions = json.cli_sessions;

      if (state.cliSessions.codex?.installed && state.cliSessions.codex?.logged_in) {
        state.currentProvider = "codex";
      } else if (state.cliSessions.claude?.installed && state.cliSessions.claude?.logged_in) {
        state.currentProvider = "claude";
      } else if (localStorage.getItem("kice_api_key_openai") || state.envKeys.openai) {
        state.currentProvider = "openai";
      } else if (localStorage.getItem("kice_api_key_anthropic") || state.envKeys.anthropic) {
        state.currentProvider = "anthropic";
      } else {
        state.currentProvider = "gemini";
      }
      const sel = document.getElementById("providerSelect");
      if (sel) sel.value = state.currentProvider;
      loadSavedApiKeyForProvider();
      updateProviderUiState();
    }
  } catch (e) {
    console.warn(e);
  }
}

async function fetchFrameworks() {
  try {
    const res = await fetch("/api/frameworks");
    const json = await res.json();
    if (json.ok && json.data) {
      state.frameworksData = json.data;
      populateSubjectSelect();
      renderActiveFrameworkBanner();
      renderFrameworkEditor();
    }
  } catch (e) {
    showAlert(`평가틀 로드 실패: ${e.message}`, "error");
  }
}

async function fetchSamples() {
  try {
    const res = await fetch("/api/samples");
    const json = await res.json();
    if (json.ok && json.data?.samples) {
      state.samples = json.data.samples;
    }
  } catch (e) {
    console.warn(e);
  }
}

async function fetchHistory() {
  try {
    const res = await fetch("/api/history");
    const json = await res.json();
    if (json.ok && json.data?.reports) {
      state.history = json.data.reports;
      renderHistoryArchive();
    }
  } catch (e) {
    console.warn(e);
  }
}

function populateSubjectSelect() {
  const select = document.getElementById("subjectSelect");
  if (!select) return;
  const subjects = state.frameworksData?.subjects || {};
  select.innerHTML = "";
  Object.values(subjects).forEach((subj) => {
    const opt = document.createElement("option");
    opt.value = subj.id;
    const isCustom = !BUILTIN_SUBJECT_IDS.has(subj.id);
    opt.textContent = isCustom ? `★ ${subj.name} (사용자정의)` : subj.name;
    if (subj.id === state.currentSubjectId) opt.selected = true;
    select.appendChild(opt);
  });
}

function getCurrentSubjectFramework() {
  return state.frameworksData?.subjects?.[state.currentSubjectId] || null;
}

function getActiveContentDomains(subj, curriculumId, electiveFilter = "") {
  if (!subj) return [];
  const byCurr = subj.content_domains_by_curriculum || {};
  const baseDomains =
    byCurr[curriculumId] && Array.isArray(byCurr[curriculumId])
      ? byCurr[curriculumId]
      : subj.content_domains || [];

  // For 15개정 Social Studies or Science, filter to the selected elective if one is chosen
  const targetEl = electiveFilter || state.selectedElective;
  if (
    curriculumId === "2015" &&
    (subj.id === "social" || subj.id === "science") &&
    targetEl &&
    targetEl !== "ALL_ELECTIVES"
  ) {
    const filtered = baseDomains.filter((d) => d.major && d.major.includes(targetEl));
    if (filtered.length > 0) return filtered;
  }
  return baseDomains;
}

function renderActiveFrameworkBanner() {
  const banner = document.getElementById("activeFrameworkBanner");
  const subj = getCurrentSubjectFramework();
  if (!banner || !subj) return;

  const currInfo = state.frameworksData?.guidelines_common?.curriculums?.[state.currentCurriculumId] || {
    name: `${state.currentCurriculumId} 개정 교육과정`,
    badge: "",
  };
  const gradeInfo = state.frameworksData?.guidelines_common?.grade_levels?.[state.currentGradeId] || {
    name: state.currentGradeId,
  };

  const activeDomains = getActiveContentDomains(subj, state.currentCurriculumId);
  const majors = activeDomains.map((d) => d.major).join(" · ");
  const behaviors = (subj.behavioral_domains || []).map((b) => b.name).join(" · ");

  const providerNames = {
    gemini: "🔵 Google Gemini API (PC 프로그램 불필요)",
    openai: "🟢 OpenAI GPT-4o API (PC 프로그램 불필요)",
    anthropic: "🟣 Anthropic Claude API (PC 프로그램 불필요)",
    web_bridge: "📋 웹 브라우저 ChatGPT/Claude 복붙 모드",
    codex: "⚡ 로컬 Codex 구독 세션",
    claude: "⚡ 로컬 Claude Code 구독 세션",
  };

  banner.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:8px;">
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <span class="tag tag-amber">${escapeHtml(gradeInfo.name)}</span>
        <span class="tag tag-blue">${escapeHtml(currInfo.name)} 자동 적용</span>
        <span class="tag tag-indigo">${escapeHtml(subj.name)}</span>
      </div>
      <span style="font-size:12.5px; font-weight:700; color:#1e40af;">${escapeHtml(providerNames[state.currentProvider] || state.currentProvider)}</span>
    </div>
    <div style="color:#334155;">
      • <strong>내용영역 단원 체계 (${escapeHtml(state.currentCurriculumId)}개정):</strong> ${escapeHtml(majors)}<br/>
      • <strong>단일 행동영역 분류축:</strong> ${escapeHtml(behaviors)}
    </div>
  `;
}

/* File Upload Handling */
async function handleFilesSelected(files) {
  hideAlert();
  const runBtn = document.getElementById("runAnalyzeBtn");
  const origBtnText = runBtn.innerHTML;
  state.isConvertingFiles = true;
  runBtn.disabled = true;

  try {
    for (const file of files) {
      const lower = file.name.toLowerCase();
      try {
        if (lower.endsWith(".pdf")) {
          state.attachments = [];
          document.getElementById("rawTextInput").value = "";
          document.getElementById("examTitleInput").value = file.name.replace(/\.pdf$/i, "");

          const pdfExtracted = await extractPdfTextAndImages(file, (currPage, totalPages) => {
            runBtn.innerHTML = `⏳ PDF 시험지 수식·텍스트 해독 중... (${currPage} / ${totalPages}페이지)`;
            showAlert(`'${file.name}' 시험지의 ${currPage}/${totalPages} 페이지를 처리하고 있습니다...`, "info");
          });

          if (pdfExtracted.text) {
            document.getElementById("rawTextInput").value = pdfExtracted.text;
          }
          if (pdfExtracted.pageImages?.length > 0) {
            pdfExtracted.pageImages.forEach((pImg) => state.attachments.push(pImg));
          } else {
            const b64 = await fileToBase64(file);
            state.attachments.push({
              name: file.name,
              mime_type: "application/pdf",
              data_base64: b64,
            });
          }

          const sectionsDetected = Array.from(
            new Set((pdfExtracted.pageImages || []).map((p) => p.section_name).filter(Boolean))
          );
          const skipMsg =
            pdfExtracted.skippedEvenPages > 0
              ? ` (총 ${pdfExtracted.totalPages}p 중 중복 짝수형 ${pdfExtracted.skippedEvenPages}p 자동 제외 → 홀수형 ${pdfExtracted.activePages}p 추출)`
              : ` (총 ${pdfExtracted.activePages || pdfExtracted.pageImages?.length || 1}페이지 추출)`;
          const secMsg = sectionsDetected.length > 0 ? ` · 감지된 영역: [${sectionsDetected.join(", ")}]` : "";

          showAlert(
            `PDF 시험지 '${file.name}' 준비 완료${skipMsg}${secMsg}. 이제 [🚀 AI 문항 분류 및 평가 실행]을 클릭하세요!`,
            "success"
          );
          trackUsage("PDF 시험지 업로드", {
            exam_title: file.name,
            detail: `${pdfExtracted.activePages || 1}페이지 추출${secMsg}`,
          });
        } else if (lower.endsWith(".hwp") || lower.endsWith(".hwpx")) {
          const b64 = await fileToBase64(file);
          runBtn.innerHTML = `⏳ 한글 문서(HWP/HWPX) 본문·수식 추출 중...`;
          const res = await fetch("/api/parse-document", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: file.name,
              data_base64: b64,
            }),
          });
          const json = await res.json();
          if (!json.ok) {
            showAlert(`한글 문서 파싱 실패 (${file.name}): ${json.error}`, "error");
            continue;
          }
          const doc = json.document;
          const rawInput = document.getElementById("rawTextInput");
          const headerLine = `=== [${doc.filename} 추출 본문 (글자수: ${doc.char_count}, 수식: ${doc.equation_count}개)] ===\n`;
          rawInput.value = (rawInput.value ? rawInput.value + "\n\n" : "") + headerLine + (doc.text || "");

          if (!document.getElementById("examTitleInput").value) {
            document.getElementById("examTitleInput").value = file.name.replace(/\.(hwpx?|pdf)$/i, "");
          }

          if (Array.isArray(doc.embedded_images) && doc.embedded_images.length > 0) {
            doc.embedded_images.forEach((img) => {
              state.attachments.push({
                name: `${file.name}_${img.name}`,
                mime_type: img.mime_type,
                data_base64: img.data_base64,
              });
            });
          }
          showAlert(
            `'${file.name}' 추출 완료: 텍스트 ${doc.char_count}자, 수식 ${doc.equation_count}개가 준비되었습니다.`,
            "success"
          );
          trackUsage("HWP/HWPX 문서 업로드", {
            exam_title: file.name,
            detail: `텍스트 ${doc.char_count}자, 수식 ${doc.equation_count}개`,
          });
        } else if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) {
          const b64 = await fileToBase64(file);
          const ext = lower.split(".").pop();
          const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
          state.attachments.push({
            name: file.name,
            mime_type: mime,
            data_base64: b64,
          });
          if (!document.getElementById("examTitleInput").value) {
            document.getElementById("examTitleInput").value = file.name.replace(/\.(png|jpe?g|webp)$/i, "");
          }
          showAlert(`문항 이미지 '${file.name}'이(가) 추가되었습니다.`, "success");
          trackUsage("문항 이미지 업로드", {
            exam_title: file.name,
          });
        } else if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv")) {
          const txt = await file.text();
          const rawInput = document.getElementById("rawTextInput");
          rawInput.value = (rawInput.value ? rawInput.value + "\n\n" : "") + txt;
          showAlert(`텍스트 파일 '${file.name}'이(가) 로드되었습니다.`, "success");
        } else if (lower.endsWith(".json")) {
          const txt = await file.text();
          const parsed = JSON.parse(txt);
          if (parsed.items || parsed.report?.items) {
            setReport(parsed.report || parsed, true);
            showAlert(`JSON 분석 리포트 '${file.name}'을(를) 불러왔습니다.`, "success");
          } else {
            document.getElementById("rawTextInput").value = txt;
          }
        }
      } catch (err) {
        showAlert(`파일 처리 중 오류 (${file.name}): ${err.message}`, "error");
      }
    }
  } finally {
    state.isConvertingFiles = false;
    runBtn.disabled = false;
    runBtn.innerHTML = origBtnText;
    renderAttachments();
  }
}

function renderAttachments() {
  const listEl = document.getElementById("attachmentList");
  const countEl = document.getElementById("attachmentCount");
  if (!listEl || !countEl) return;
  countEl.textContent = String(state.attachments.length);

  if (state.attachments.length === 0) {
    listEl.innerHTML = `<div class="empty-hint">업로드된 시험지 페이지나 문항 이미지가 여기에 썸네일로 표시됩니다.</div>`;
    return;
  }

  listEl.innerHTML = state.attachments
    .map((att, idx) => {
      const isPdf = att.mime_type === "application/pdf";
      const previewHtml = isPdf
        ? `<div class="attachment-pdf-box">📑 PDF 원본</div>`
        : `<img class="attachment-thumb" src="data:${att.mime_type};base64,${att.data_base64}" alt="${escapeHtml(att.name)}" />`;
      return `
        <div class="attachment-item">
          <button type="button" class="attachment-remove" onclick="removeAttachment(${idx})" title="제거">&times;</button>
          ${previewHtml}
          <div class="attachment-meta" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</div>
        </div>
      `;
    })
    .join("");
}

window.removeAttachment = function (idx) {
  state.attachments.splice(idx, 1);
  renderAttachments();
};

function loadSampleIntoInputs(sampleId) {
  const sample = state.samples.find((s) => s.id === sampleId);
  if (!sample) return;

  state.currentSubjectId = sample.subject_id || "math";
  state.currentGradeId = sample.grade_id || "grade3";
  updateAutoCurriculumBadge();

  if (sample.elective) {
    state.selectedElective = sample.elective;
    state.activeElectiveView = sample.elective;
  }

  document.getElementById("subjectSelect").value = state.currentSubjectId;
  document.getElementById("gradeSelect").value = state.currentGradeId;

  syncElectiveDropdownOptions();
  renderActiveFrameworkBanner();
  renderFrameworkEditor();

  state.attachments = [];
  renderAttachments();

  document.getElementById("examTitleInput").value = sample.exam_title;
  document.getElementById("rawTextInput").value = sample.raw_text;
  triggerMathRender();

  if (sample.preanalyzed) {
    setReport(sample.preanalyzed, true);
    showAlert(
      `'${sample.exam_title}' 샘플 분석 리포트가 대시보드에 로드되었습니다!`,
      "success"
    );
  } else {
    showAlert(
      `'${sample.exam_title}' 예제 문항이 준비되었습니다. [🚀 AI 문항 분류 및 평가 실행]을 클릭하세요.`,
      "info"
    );
  }

  trackUsage("예제 샘플 열람", {
    exam_title: sample.exam_title,
    item_count: sample.preanalyzed?.items?.length || "",
    detail: sampleId,
  });
}

/* Web Browser Copy-Paste Bridge Mode (Works with zero CLI and zero API keys!) */
async function openWebBridgeModal() {
  const modal = document.getElementById("webBridgeModal");
  const promptArea = document.getElementById("bridgePromptTextarea");
  if (!modal || !promptArea) return;

  modal.classList.remove("hidden");
  promptArea.value = "KICE 평가틀 및 시험 문항 프롬프트를 생성하고 있습니다...";

  try {
    const examTitle = document.getElementById("examTitleInput")?.value.trim() || "수능·모의고사 문항 분류 분석";
    const targetRange = document.getElementById("targetRangeInput")?.value.trim() || "";
    const customInstruction = document.getElementById("customInstructionInput")?.value.trim() || "";
    const rawText = document.getElementById("rawTextInput")?.value.trim() || "";

    const res = await fetch("/api/build-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject_id: state.currentSubjectId,
        grade_id: state.currentGradeId,
        selected_elective: state.selectedElective,
        target_range: targetRange,
        custom_instruction: customInstruction,
        subject_framework: getCurrentSubjectFramework(),
      }),
    });
    const json = await res.json();
    const sysPrompt = json.system_prompt || "";

    let combinedPrompt = `${sysPrompt}\n\n========================================\n[시험 제목]: ${examTitle}\n`;
    if (rawText) {
      combinedPrompt += `\n[시험 문항 텍스트 및 수식 데이터]\n${rawText}\n`;
    } else {
      combinedPrompt += `\n(첨부할 시험지 파일/이미지와 함께 이 프롬프트를 전송해 주세요.)\n`;
    }
    promptArea.value = combinedPrompt;
  } catch (err) {
    promptArea.value = `프롬프트 생성 오류: ${err.message}`;
  }
}

function closeWebBridgeModal() {
  document.getElementById("webBridgeModal")?.classList.add("hidden");
}

async function copyBridgePromptToClipboard() {
  const promptArea = document.getElementById("bridgePromptTextarea");
  if (!promptArea) return;
  trackUsage("웹AI 프롬프트 복사", { provider: "web_bridge" });
  try {
    await navigator.clipboard.writeText(promptArea.value);
    showAlert("분석 프롬프트가 클립보드에 복사되었습니다! 웹 ChatGPT 또는 Claude.ai 창에 붙여넣기(Cmd+V) 하세요.", "success");
  } catch (_) {
    promptArea.select();
    document.execCommand("copy");
    showAlert("분석 프롬프트가 복사되었습니다!", "success");
  }
}

async function applyWebBridgeResult() {
  const respArea = document.getElementById("bridgeResponseTextarea");
  const raw = respArea?.value.trim() || "";
  if (!raw) {
    showAlert("웹 AI가 출력한 JSON 결과를 먼저 붙여넣어 주세요.", "error");
    return;
  }
  try {
    let cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }
    const report = JSON.parse(cleaned);
    if (!report.items || !Array.isArray(report.items)) {
      throw new Error("JSON 내에 'items' 문항 배열이 없습니다.");
    }
    closeWebBridgeModal();
    setReport(report, true);
    await fetch("/api/history/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report }),
    }).catch(() => {});
    await fetchHistory();
    trackUsage("웹AI 복붙 분석 완료", {
      exam_title: report.exam_title || "",
      item_count: report.items.length,
      provider: "web_bridge",
    });
    showAlert("웹 AI 분석 결과가 성공적으로 반영되어 리포트가 생성되었습니다!", "success");
  } catch (err) {
    showAlert(`JSON 파싱 오류: ${err.message}`, "error");
  }
}

/* Single Batch API Call */
async function executeSingleAnalysisBatch({
  provider,
  apiKey,
  examTitle,
  rawText,
  targetRange,
  customInstruction,
  mediaParts,
}) {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      api_key: apiKey,
      subject_id: state.currentSubjectId,
      grade_id: state.currentGradeId,
      selected_elective: state.selectedElective,
      exam_title: examTitle,
      raw_text: rawText,
      target_range: targetRange,
      custom_instruction: customInstruction,
      media_parts: mediaParts,
      subject_framework: getCurrentSubjectFramework(),
    }),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(json.error || "분석 요청 처리 중 오류가 발생했습니다.");
  }
  return json.report;
}

function filterPageAttachmentsByRange(imageAttachments, targetRange) {
  const hasSectionMeta = imageAttachments.some((a) => a.section_name);
  if (!hasSectionMeta) return imageAttachments;

  const r = (targetRange || "").trim();

  if (!r) {
    if (
      state.selectedElective &&
      state.selectedElective !== "ALL_ELECTIVES" &&
      imageAttachments.some((a) => a.section_name === state.selectedElective)
    ) {
      const allowed = new Set(["공통과목", state.selectedElective]);
      const filtered = imageAttachments.filter((a) => allowed.has(a.section_name || "공통과목"));
      if (filtered.length > 0) return filtered;
    }
    return imageAttachments;
  }

  const allCandidates = [
    "공통",
    "확률과 통계",
    "확통",
    "미적분",
    "기하",
    "화법과 작문",
    "언어와 매체",
    ...SOCIAL_15_ELECTIVES,
    ...SCIENCE_15_ELECTIVES,
  ];
  const matchedAny = allCandidates.some((c) => r.includes(c));
  if (!matchedAny) return imageAttachments;

  const allowedSections = new Set();
  if (r.includes("공통")) allowedSections.add("공통과목");
  if (r.includes("확률과 통계") || r.includes("확통")) allowedSections.add("확률과 통계");
  if (r.includes("미적분")) allowedSections.add("미적분");
  if (r.includes("기하")) allowedSections.add("기하");
  if (r.includes("화법과 작문") || r.includes("화작")) allowedSections.add("화법과 작문");
  if (r.includes("언어와 매체") || r.includes("언매")) allowedSections.add("언어와 매체");
  for (const sName of [...SOCIAL_15_ELECTIVES, ...SCIENCE_15_ELECTIVES]) {
    if (r.includes(sName)) allowedSections.add(sName);
  }

  const filtered = imageAttachments.filter((a) => allowedSections.has(a.section_name || "공통과목"));
  return filtered.length > 0 ? filtered : imageAttachments;
}

function buildSectionAwareBatches(imageAttachments) {
  const batches = [];
  let currentBatch = [];
  let currentSec = null;

  for (const img of imageAttachments) {
    const sec = img.section_name || "공통과목";
    const limit = sec === "공통과목" ? 3 : 4;
    if (currentBatch.length >= limit || (currentSec !== null && sec !== currentSec)) {
      if (currentBatch.length > 0) batches.push({ section: currentSec, pages: currentBatch });
      currentBatch = [img];
      currentSec = sec;
    } else {
      currentBatch.push(img);
      currentSec = sec;
    }
  }
  if (currentBatch.length > 0) {
    batches.push({ section: currentSec, pages: currentBatch });
  }
  return batches;
}

function normalizeBatchItems(items, sectionName) {
  if (!Array.isArray(items)) return [];
  const isElective = sectionName && sectionName !== "공통과목";
  return items.map((it) => {
    let numStr = String(it.item_number || "").trim();
    if (isElective && !numStr.includes(sectionName)) {
      const bareNum = numStr.replace(/^[^0-9]+/, "").trim() || numStr;
      numStr = `${sectionName} ${bareNum}`;
    }
    return {
      ...it,
      item_number: numStr,
    };
  });
}

function getItemElectiveGroup(item) {
  const numStr = String(item?.item_number || "").trim();
  const majorStr = String(item?.content_domain?.major || "").trim();

  if (numStr.includes("확률과 통계") || numStr.includes("확통") || majorStr.includes("확률과 통계")) {
    return "확률과 통계";
  }
  if (
    numStr.includes("미적분") ||
    (majorStr.includes("미적분") && !majorStr.includes("미적분 I") && !majorStr.includes("미적분Ⅰ"))
  ) {
    return "미적분";
  }
  if (numStr.includes("기하") || majorStr.includes("기하")) {
    return "기하";
  }
  if (numStr.includes("화법과 작문") || majorStr.includes("화법과 작문")) {
    return "화법과 작문";
  }
  if (numStr.includes("언어와 매체") || majorStr.includes("언어와 매체")) {
    return "언어와 매체";
  }
  for (const sName of [...SOCIAL_15_ELECTIVES, ...SCIENCE_15_ELECTIVES]) {
    if (numStr.includes(sName) || majorStr.includes(sName)) {
      return sName;
    }
  }
  return "공통";
}

function formatFullSetItemNumber(item, isSingleFullSetView) {
  const raw = String(item?.item_number || "").trim();
  if (!isSingleFullSetView) return raw;
  const allElectives = [
    "확률과 통계",
    "미적분",
    "기하",
    "화법과 작문",
    "언어와 매체",
    ...SOCIAL_15_ELECTIVES,
    ...SCIENCE_15_ELECTIVES,
  ];
  for (const el of allElectives) {
    if (raw.startsWith(el)) {
      const rest = raw.slice(el.length).trim();
      if (/^\d+$/.test(rest)) {
        return `${rest} (${el})`;
      }
    }
  }
  return raw;
}

function getActiveFullSetView(report) {
  const rawItems = report?.items || [];
  const indexed = rawItems.map((item, rawIndex) => ({
    item,
    rawIndex,
    group: getItemElectiveGroup(item),
  }));

  const commonEntries = indexed.filter((e) => e.group === "공통");
  const electiveOrder = [
    "미적분",
    "확률과 통계",
    "기하",
    "화법과 작문",
    "언어와 매체",
    ...SOCIAL_15_ELECTIVES,
    ...SCIENCE_15_ELECTIVES,
  ];
  const availableElectives = electiveOrder.filter((el) => indexed.some((e) => e.group === el));

  const hasMultipleElectives = availableElectives.length > 1;
  const isFullMockExam =
    hasMultipleElectives || (availableElectives.length === 1 && commonEntries.length >= 15);

  if (!isFullMockExam) {
    return {
      isFullMockExam: false,
      hasMultipleElectives: false,
      availableElectives,
      activeElective: availableElectives[0] || null,
      commonEntries,
      activeEntries: indexed.map((e) => ({
        ...e,
        displayNumber: String(e.item.item_number || ""),
      })),
    };
  }

  let activeElective = state.activeElectiveView;
  if (
    activeElective !== "COMMON_ONLY" &&
    !availableElectives.includes(activeElective)
  ) {
    activeElective =
      state.selectedElective && availableElectives.includes(state.selectedElective)
        ? state.selectedElective
        : availableElectives[0];
    state.activeElectiveView = activeElective;
  }

  let chosenEntries = [];
  if (activeElective === "COMMON_ONLY") {
    chosenEntries = [...commonEntries];
  } else {
    const electiveEntries = indexed.filter((e) => e.group === activeElective);
    chosenEntries = [...commonEntries, ...electiveEntries];
  }

  chosenEntries.sort((a, b) => {
    const na = parseInt(String(a.item.item_number).replace(/^[^0-9]+/, ""), 10) || 999;
    const nb = parseInt(String(b.item.item_number).replace(/^[^0-9]+/, ""), 10) || 999;
    return na - nb;
  });

  return {
    isFullMockExam: true,
    hasMultipleElectives,
    availableElectives,
    activeElective,
    commonEntries,
    activeEntries: chosenEntries.map((e) => ({
      ...e,
      displayNumber: formatFullSetItemNumber(e.item, true),
    })),
  };
}

window.switchElectiveFullSetView = function (electiveName) {
  state.activeElectiveView = electiveName;
  if (electiveName !== "COMMON_ONLY") {
    state.selectedElective = electiveName;
    const sel = document.getElementById("electiveSelect");
    if (sel && Array.from(sel.options).some((o) => o.value === electiveName)) {
      sel.value = electiveName;
    }
  }
  renderDashboardView();
  populateItemFilters();
  renderItemsView();
};

function renderElectiveSwitcherBars(fullSetInfo) {
  const dashBar = document.getElementById("dashElectiveSwitcher");
  const itemsBar = document.getElementById("itemsElectiveSwitcher");
  if (!dashBar || !itemsBar) return;

  if (!fullSetInfo.isFullMockExam) {
    dashBar.classList.add("hidden");
    itemsBar.classList.add("hidden");
    return;
  }

  const commonCount = fullSetInfo.commonEntries.length;
  const commonPts = fullSetInfo.commonEntries.reduce(
    (acc, e) => acc + (Number(e.item.points) || 0),
    0
  );

  const rawItems = state.currentReport?.items || [];
  const btnsHtml = fullSetInfo.availableElectives
    .map((elName) => {
      const elItems = rawItems.filter((it) => getItemElectiveGroup(it) === elName);
      const totalCnt = commonCount + elItems.length;
      const totalPts =
        commonPts + elItems.reduce((acc, it) => acc + (Number(it.points) || 0), 0);
      const isActive = fullSetInfo.activeElective === elName;
      const prefix = commonCount > 0 ? `공통 + ${elName}` : elName;
      return `
        <button type="button" class="elective-tab-btn ${isActive ? "active" : ""}" onclick="switchElectiveFullSetView('${escapeHtml(elName)}')">
          🎯 ${escapeHtml(prefix)} 풀세트
          <span class="elective-sub-pill">${totalCnt}문항 · ${totalPts}점</span>
        </button>
      `;
    })
    .join("");

  const commonOnlyBtn =
    commonCount > 0
      ? `
        <button type="button" class="elective-tab-btn ${fullSetInfo.activeElective === "COMMON_ONLY" ? "active" : ""}" onclick="switchElectiveFullSetView('COMMON_ONLY')">
          공통과목만
          <span class="elective-sub-pill">${commonCount}문항 · ${commonPts}점</span>
        </button>
      `
      : "";

  const totalActivePts = fullSetInfo.activeEntries.reduce(
    (a, e) => a + (Number(e.item.points) || 0),
    0
  );
  const activeLabel =
    fullSetInfo.activeElective === "COMMON_ONLY"
      ? `공통과목 (${commonCount}문항 · ${commonPts}점)`
      : commonCount > 0
      ? `공통 + ${fullSetInfo.activeElective} 풀세트 (${fullSetInfo.activeEntries.length}문항 · ${totalActivePts}점 만점)`
      : `${fullSetInfo.activeElective} (${fullSetInfo.activeEntries.length}문항 · ${totalActivePts}점 만점)`;

  const innerHtml = `
    <div class="elective-switcher-title">
      <strong>🎯 응시 선택과목 풀세트 기준 보기 — 현재: [${escapeHtml(activeLabel)}]</strong>
      <span>선택과목이 있는 시험지는 수험생 1인의 응시 풀세트(예: 수학 30문항·100점, 국어 45문항·100점, 탐구 20문항·50점) 기준으로 집계됩니다.</span>
    </div>
    <div class="elective-switcher-btns">
      ${btnsHtml}
      ${commonOnlyBtn}
    </div>
  `;

  dashBar.innerHTML = innerHtml;
  itemsBar.innerHTML = innerHtml;
  dashBar.classList.remove("hidden");
  itemsBar.classList.remove("hidden");
}

/* Run AI Analysis */
async function runAiAnalysis() {
  hideAlert();
  if (state.isConvertingFiles) {
    showAlert("현재 PDF 시험지 페이지를 변환 중입니다. 잠시 후 다시 실행해 주세요.", "info");
    return;
  }

  const provider = state.currentProvider;
  if (provider === "web_bridge") {
    openWebBridgeModal();
    return;
  }

  const apiKey = document.getElementById("apiKeyInput")?.value.trim() || "";
  const examTitle = document.getElementById("examTitleInput")?.value.trim() || "수능·모의고사 문항 분류 분석";
  const targetRange = document.getElementById("targetRangeInput")?.value.trim() || "";
  const rawText = document.getElementById("rawTextInput")?.value.trim() || "";
  const customInstruction = document.getElementById("customInstructionInput")?.value.trim() || "";
  const fastTextMode = Boolean(document.getElementById("fastTextModeCheckbox")?.checked);

  if (!rawText && state.attachments.length === 0) {
    showAlert("분석할 시험지 파일(PDF, 이미지, HWP/HWPX)을 먼저 업로드하거나 왼쪽 예제 세트를 선택해 주세요.", "error");
    return;
  }

  if (
    (provider === "gemini" || provider === "openai" || provider === "anthropic") &&
    !apiKey &&
    !state.envKeys?.[provider]
  ) {
    showAlert(
      `선택하신 [${provider.toUpperCase()} API] 모드에서는 API Key 입력이 필요합니다. API 키나 설치 프로그램 없이 사용하시려면 상단 연결 방식을 [📋 웹 브라우저 ChatGPT/Claude 복붙 모드]로 선택하세요.`,
      "error"
    );
    return;
  }

  const runBtn = document.getElementById("runAnalyzeBtn");
  const loadingBox = document.getElementById("loadingBox");
  const loadingTitle = document.getElementById("loadingTitle");
  const loadingDesc = document.getElementById("loadingDesc");
  const progressBar = document.getElementById("loadingProgressBar");

  runBtn.disabled = true;
  loadingBox.classList.remove("hidden");
  if (progressBar) progressBar.style.width = "15%";

  try {
    const allImageAttachments = state.attachments.filter((a) => a.mime_type.startsWith("image/"));
    const targetImageAttachments = filterPageAttachmentsByRange(allImageAttachments, targetRange);
    const BATCH_SIZE = 3;

    const electiveSections = new Set(
      targetImageAttachments
        .map((a) => a.section_name)
        .filter((s) => s && s !== "공통과목")
    );

    let finalReport = null;

    if (targetImageAttachments.length > BATCH_SIZE || electiveSections.size >= 1) {
      const batches = buildSectionAwareBatches(targetImageAttachments);
      const batchResults = new Array(batches.length).fill(null);
      let completedCount = 0;

      const updateLiveReport = () => {
        const mergedItems = [];
        let firstOverall = null;
        let sampleMeta = null;
        const mergedChallenging = [];

        for (let i = 0; i < batches.length; i++) {
          const rep = batchResults[i];
          if (!rep) continue;
          if (!sampleMeta) sampleMeta = rep;
          if (!firstOverall && rep.overall_evaluation) {
            firstOverall = rep.overall_evaluation;
          }
          if (Array.isArray(rep.overall_evaluation?.challenging_items)) {
            rep.overall_evaluation.challenging_items.forEach((ci) => {
              if (ci && ci.item_number) mergedChallenging.push(ci);
            });
          }
          const normalized = normalizeBatchItems(rep.items || [], batches[i].section);
          mergedItems.push(...normalized);
        }

        if (sampleMeta) {
          const combinedOverall = {
            ...(firstOverall || sampleMeta.overall_evaluation || {}),
          };
          if (mergedChallenging.length > 0) {
            combinedOverall.challenging_items = mergedChallenging.slice(0, 8);
          }
          finalReport = {
            ...sampleMeta,
            exam_title: examTitle,
            items: mergedItems,
            overall_evaluation: combinedOverall,
          };
          setReport(finalReport, false);
        }
      };

      loadingTitle.textContent = `AI 병렬 문항 분류 실행 중... (총 ${batches.length}개 구간 동시 처리)`;
      loadingDesc.textContent = `내용영역, 단일 행동영역, 시험 전체 난이도 및 주요 고난도 문항을 분석하고 있습니다...`;

      const CONCURRENCY = 3;
      let nextBatchIdx = 0;

      async function worker() {
        while (nextBatchIdx < batches.length) {
          const bIdx = nextBatchIdx++;
          const batchObj = batches[bIdx];
          const batchImgs = batchObj.pages;
          const secName = batchObj.section || "공통과목";

          const batchPageText = batchImgs
            .map((img) => img.page_text || "")
            .filter(Boolean)
            .join("\n\n");

          const hasRichDigitalText = batchPageText.length > 150;
          const mediaToSend = fastTextMode && hasRichDigitalText ? [] : batchImgs;

          const sectionRangeHint =
            secName !== "공통과목"
              ? `선택과목 [${secName}] 페이지에 해당하는 모든 문항을 빠짐없이 분석하고 item_number에 '${secName} 23' (또는 탐구 영역은 '${secName} 1') 형식으로 표기하십시오.`
              : "제공된 공통과목 페이지에 등장하는 모든 문항을 번호 순서대로 단 한 문항도 빠짐없이 분석하십시오.";

          const rep = await executeSingleAnalysisBatch({
            provider,
            apiKey,
            examTitle,
            rawText: batchPageText || (bIdx === 0 ? rawText.slice(0, 8000) : ""),
            targetRange: sectionRangeHint,
            customInstruction,
            mediaParts: mediaToSend,
          });

          batchResults[bIdx] = rep;
          completedCount++;
          const pct = Math.min(96, Math.round((completedCount / batches.length) * 100));
          if (progressBar) progressBar.style.width = `${pct}%`;

          updateLiveReport();
          const activeSet = getActiveFullSetView(finalReport);
          loadingTitle.textContent = `AI 병렬 분석 진행 중... (${completedCount}/${batches.length} 구간 완료)`;
          loadingDesc.textContent = `현재 분류 완료된 풀세트 문항: ${activeSet.activeEntries.length}문항`;
        }
      }

      const workers = [];
      for (let w = 0; w < Math.min(CONCURRENCY, batches.length); w++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (progressBar) progressBar.style.width = "100%";
      await fetch("/api/history/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report: finalReport }),
      }).catch(() => {});
    } else {
      const batchPageText = targetImageAttachments
        .map((img) => img.page_text || "")
        .filter(Boolean)
        .join("\n\n");
      const effectiveRawText = batchPageText || rawText;
      const hasRichDigitalText = batchPageText.length > 150;
      const mediaToSend =
        fastTextMode && hasRichDigitalText
          ? []
          : targetImageAttachments.length > 0
          ? targetImageAttachments
          : state.attachments;

      loadingTitle.textContent = `AI가 문항을 고속 분류 및 평가 중입니다...`;
      loadingDesc.textContent = `적용 교육과정(${state.currentCurriculumId}개정) 기준 내용영역·단일 행동영역 분류 및 시험 전체 난이도를 분석하고 있습니다.`;
      if (progressBar) progressBar.style.width = "45%";

      finalReport = await executeSingleAnalysisBatch({
        provider,
        apiKey,
        examTitle,
        rawText: effectiveRawText,
        targetRange,
        customInstruction,
        mediaParts: mediaToSend,
      });
      if (progressBar) progressBar.style.width = "100%";
    }

    setReport(finalReport, true);
    await fetchHistory();
    const activeSet = getActiveFullSetView(finalReport);
    const totalPts = activeSet.activeEntries.reduce(
      (acc, e) => acc + (Number(e.item.points) || 0),
      0
    );
    trackUsage("AI 문항 분석 완료", {
      exam_title: finalReport.exam_title || examTitle,
      item_count: activeSet.activeEntries.length,
      provider,
      detail: `총 ${finalReport.items?.length || 0}문항 분석 (${totalPts}점 풀세트)`,
    });
    showAlert(
      `[${finalReport.curriculum_name || state.currentCurriculumId + "개정"}] 총 ${activeSet.activeEntries.length}문항 (${totalPts}점) 분류 및 전체 난이도 분석이 완료되었습니다!`,
      "success"
    );
  } catch (err) {
    trackUsage("AI 분석 오류", {
      exam_title: examTitle,
      provider,
      detail: err.message,
    });
    showAlert(err.message, "error");
  } finally {
    runBtn.disabled = false;
    loadingBox.classList.add("hidden");
  }
}

/* Set Active Report & Render Views */
function setReport(report, navigateToDashboard = false) {
  state.currentReport = JSON.parse(JSON.stringify(report));

  if (report.subject_id && state.frameworksData?.subjects?.[report.subject_id]) {
    state.currentSubjectId = report.subject_id;
    const subjSel = document.getElementById("subjectSelect");
    if (subjSel) subjSel.value = report.subject_id;
  }
  if (report.curriculum_id === "2015") {
    state.currentGradeId = "grade3";
  } else if (report.curriculum_id === "2022" && state.currentGradeId === "grade3") {
    state.currentGradeId = "grade1";
  }
  const gradeSel = document.getElementById("gradeSelect");
  if (gradeSel) gradeSel.value = state.currentGradeId;
  updateAutoCurriculumBadge();

  syncElectiveDropdownOptions();
  renderActiveFrameworkBanner();
  renderFrameworkEditor();

  const fullSetInfo = getActiveFullSetView(state.currentReport);
  const navCnt = document.getElementById("navItemCount");
  if (navCnt) navCnt.textContent = String(fullSetInfo.activeEntries.length);

  renderDashboardView();
  populateItemFilters();
  renderItemsView();

  if (navigateToDashboard) {
    switchTab("tab-dashboard");
  } else {
    triggerMathRender();
  }
}

/* Synthesize Overall Difficulty & Challenging Items if loading a report that didn't have them explicitly */
function getSynthesizedOverallDifficultyAndChallenging(rep, items) {
  const ov = rep.overall_evaluation || {};
  let overallDiffText = ov.overall_difficulty || "";
  if (!overallDiffText) {
    const highPtsCount = items.filter((it) => Number(it.points) >= 4 || (rep.subject_id !== "math" && Number(it.points) >= 3)).length;
    overallDiffText =
      ov.estimated_grade1_cut
        ? `전반적으로 기본 개념 확인 문항과 상위권 변별용 고배점 추론·문제해결 문항(${highPtsCount}문항)이 조화롭게 배치된 변별력 확보형 시험입니다. (참고 지표: ${ov.estimated_grade1_cut})`
        : `전반적으로 교육과정 성취기준에 충실한 기본 문항과 고배점 추론·문제해결 문항(${highPtsCount}문항)이 균형 있게 출제되어 상위권 변별력을 확보한 시험입니다.`;
  }

  let challengingList = Array.isArray(ov.challenging_items) ? ov.challenging_items : [];
  if (challengingList.length === 0) {
    // Automatically extract top challenging items from the active set (e.g. 14, 15, 21, 22, 28, 29, 30 or high-score items)
    const candidates = [...items].filter((it) => {
      const score = Number(it.difficulty?.score) || 0;
      const pts = Number(it.points) || 0;
      const disp = String(it._displayNumber || it.item_number || "");
      return (
        score >= 7 ||
        pts >= 4 ||
        /^(14|15|21|22|28|29|30)\b/.test(disp) ||
        (rep.subject_id !== "math" && pts >= 3)
      );
    });
    candidates.sort((a, b) => (Number(b.difficulty?.score) || Number(b.points) || 0) - (Number(a.difficulty?.score) || Number(a.points) || 0));
    challengingList = candidates.slice(0, 5).map((it) => ({
      item_number: it._displayNumber || it.item_number,
      topic: `${it.content_domain?.middle || ""} — ${it.content_domain?.topic || ""}`.replace(/^ — | — $/g, ""),
      reason:
        it.evaluation?.bottleneck_and_distractors ||
        it.evaluation?.intent_and_key_idea ||
        it.stem_summary ||
        "복합 개념 적용 및 다단계 추론이 요구되는 주요 변별 문항입니다.",
      _rawIndex: it._rawIndex,
    }));
  } else {
    // Filter challengingList so it matches the active elective view if full mock exam
    challengingList = challengingList
      .map((ci) => {
        const matchedItem = items.find(
          (it) =>
            String(it.item_number) === String(ci.item_number) ||
            String(it._displayNumber) === String(ci.item_number) ||
            String(it._displayNumber).startsWith(String(ci.item_number) + " ")
        );
        return {
          ...ci,
          _rawIndex: matchedItem ? matchedItem._rawIndex : undefined,
        };
      })
      .filter((ci) => {
        // Exclude other electives not in the current active set
        const numS = String(ci.item_number || "");
        for (const el of ["미적분", "확률과 통계", "기하", "화법과 작문", "언어와 매체"]) {
          if (numS.includes(el) && state.activeElectiveView && state.activeElectiveView !== el) {
            return false;
          }
        }
        return true;
      });
  }

  return { overallDiffText, challengingList };
}

/* Render Tab 2: Dashboard & Two-Way Specification Matrix */
function renderDashboardView() {
  const rep = state.currentReport;
  if (!rep) return;

  const fullSetInfo = getActiveFullSetView(rep);
  renderElectiveSwitcherBars(fullSetInfo);

  const activeEntries = fullSetInfo.activeEntries;
  const items = activeEntries.map((e) => ({
    ...e.item,
    _rawIndex: e.rawIndex,
    _displayNumber: e.displayNumber,
  }));

  document.getElementById("navItemCount").textContent = String(items.length);

  document.getElementById("dashCurriculumBadge").textContent =
    rep.curriculum_name || `${state.currentCurriculumId} 개정 교육과정`;
  document.getElementById("dashGradeBadge").textContent =
    rep.target_grade || (state.currentCurriculumId === "2015" ? "고3 · N수생 (15개정)" : "고1·고2 (22개정)");

  const subjLabel =
    fullSetInfo.isFullMockExam && fullSetInfo.activeElective && fullSetInfo.activeElective !== "COMMON_ONLY"
      ? `${rep.subject_name || "수학 영역"} (공통 + ${fullSetInfo.activeElective} 풀세트)`
      : rep.subject_name || "과목 미지정";
  document.getElementById("dashSubjectBadge").textContent = subjLabel;
  document.getElementById("dashDateBadge").textContent = rep.analyzed_at || "-";
  document.getElementById("dashExamTitle").textContent = rep.exam_title || "문항 분류 분석 보고서";

  const totalPoints = items.reduce((acc, it) => acc + (Number(it.points) || 0), 0);
  const { overallDiffText, challengingList } = getSynthesizedOverallDifficultyAndChallenging(rep, items);

  document.getElementById("kpiTotalItems").textContent = `${items.length}문항`;
  document.getElementById("kpiTotalPoints").textContent = `${totalPoints}점`;
  document.getElementById("kpiChallengingCount").textContent = `${challengingList.length}문항 집중 분석`;

  document.getElementById("evalSummaryText").textContent =
    rep.overall_evaluation?.summary || "시험 전체 출제 경향 요약 정보가 없습니다.";
  document.getElementById("evalOverallDifficultyText").textContent = overallDiffText;
  document.getElementById("evalCurriculumGradeText").textContent =
    rep.overall_evaluation?.curriculum_and_grade_review ||
    `${rep.curriculum_name || state.currentCurriculumId + " 개정 교육과정"} 성취기준 및 이수 범위에 맞추어 분석되었습니다.`;
  document.getElementById("evalContentBalanceText").textContent =
    rep.overall_evaluation?.content_balance_review || "-";
  document.getElementById("evalBehaviorBalanceText").textContent =
    rep.overall_evaluation?.behavioral_balance_review || "-";

  const challengingEl = document.getElementById("challengingItemsList");
  if (challengingEl) {
    if (challengingList.length === 0) {
      challengingEl.innerHTML = `<div class="empty-hint">특이 고난도 문항이 없거나 평이한 구성의 시험입니다.</div>`;
    } else {
      challengingEl.innerHTML = challengingList
        .map((ci) => {
          const clickAttr =
            ci._rawIndex !== undefined ? `onclick="jumpToItemCard(${ci._rawIndex})"` : "";
          return `
            <div class="challenging-item-card" ${clickAttr} title="클릭하면 해당 문항 상세 카드로 이동합니다">
              <div class="challenging-item-top">
                <span class="challenging-q-badge">문항 ${escapeHtml(ci.item_number)}번</span>
                <span class="challenging-topic">${escapeHtml(ci.topic || "주요 고난도·변별 문항")}</span>
              </div>
              <p class="challenging-reason">${escapeHtml(ci.reason || "")}</p>
            </div>
          `;
        })
        .join("");
    }
  }

  renderTwoWayMatrix(items);
  renderDistributionCharts(items);
}

function renderTwoWayMatrix(items) {
  const table = document.getElementById("twoWayMatrixTable");
  if (!table) return;
  const subj = getCurrentSubjectFramework();
  const activeDomains = getActiveContentDomains(subj, state.currentCurriculumId);

  const behaviorCols = [];
  if (subj && Array.isArray(subj.behavioral_domains)) {
    subj.behavioral_domains.forEach((b) => {
      const clean = cleanBehaviorLabel(b.name);
      if (!behaviorCols.includes(clean)) behaviorCols.push(clean);
    });
  }
  items.forEach((it) => {
    const bName = cleanBehaviorLabel(it.behavioral_domain?.primary || "기타");
    const matched = matchBehaviorColumn(bName, behaviorCols);
    if (!matched && !behaviorCols.includes(bName)) {
      behaviorCols.push(bName);
    }
  });

  const contentRows = [];
  const rowKeySet = new Set();

  activeDomains.forEach((majObj) => {
    (majObj.middle || []).forEach((midObj) => {
      const key = `${majObj.major}||${midObj.name}`;
      rowKeySet.add(key);
      contentRows.push({ major: majObj.major, middle: midObj.name, key });
    });
  });

  const cellMap = {};
  contentRows.forEach((r) => {
    cellMap[r.key] = {};
    behaviorCols.forEach((b) => (cellMap[r.key][b] = []));
  });

  items.forEach((it, idx) => {
    const maj = it.content_domain?.major || "기타";
    const mid = it.content_domain?.middle || "기타";
    let targetKey = findMatchingContentRowKey(maj, mid, contentRows);
    if (!targetKey) {
      targetKey = `${maj}||${mid}`;
      if (!rowKeySet.has(targetKey)) {
        rowKeySet.add(targetKey);
        contentRows.push({ major: maj, middle: mid, key: targetKey });
        cellMap[targetKey] = {};
        behaviorCols.forEach((b) => (cellMap[targetKey][b] = []));
      }
    }
    const bPrimary = cleanBehaviorLabel(it.behavioral_domain?.primary || behaviorCols[0] || "기타");
    const targetBCol = matchBehaviorColumn(bPrimary, behaviorCols) || bPrimary;
    if (!cellMap[targetKey][targetBCol]) {
      cellMap[targetKey][targetBCol] = [];
    }
    cellMap[targetKey][targetBCol].push({ item: it, index: it._rawIndex ?? idx });
  });

  const activeMajors = new Set(
    contentRows
      .filter((r) => behaviorCols.some((b) => (cellMap[r.key]?.[b]?.length || 0) > 0))
      .map((r) => r.major)
  );
  const displayRows =
    activeMajors.size > 0
      ? contentRows.filter((r) => activeMajors.has(r.major))
      : contentRows;

  const majorCounts = {};
  displayRows.forEach((r) => {
    majorCounts[r.major] = (majorCounts[r.major] || 0) + 1;
  });

  let html = `
    <thead>
      <tr>
        <th colspan="2">내용영역 (${escapeHtml(state.currentCurriculumId)}개정 대분류 · 중분류)</th>
        ${behaviorCols.map((b) => `<th>${escapeHtml(b)}</th>`).join("")}
        <th>합계 (문항수 / 배점 / 비율)</th>
      </tr>
    </thead>
    <tbody>
  `;

  const renderedMajors = new Set();
  const colTotals = {};
  behaviorCols.forEach((b) => (colTotals[b] = { count: 0, points: 0 }));
  let grandCount = 0;
  let grandPoints = 0;

  displayRows.forEach((row) => {
    html += `<tr>`;
    if (!renderedMajors.has(row.major)) {
      renderedMajors.add(row.major);
      html += `<td class="matrix-major-cell" rowspan="${majorCounts[row.major]}">${escapeHtml(row.major)}</td>`;
    }
    html += `<td class="matrix-middle-cell">${escapeHtml(row.middle)}</td>`;

    let rowCount = 0;
    let rowPoints = 0;

    behaviorCols.forEach((bCol) => {
      const entries = cellMap[row.key]?.[bCol] || [];
      const c = entries.length;
      const pts = entries.reduce((acc, e) => acc + (Number(e.item.points) || 0), 0);
      rowCount += c;
      rowPoints += pts;
      colTotals[bCol].count += c;
      colTotals[bCol].points += pts;

      if (c === 0) {
        html += `<td class="matrix-cell" style="color:#cbd5e1;">-</td>`;
      } else {
        const pills = entries
          .map(({ item, index }) => {
            const dispNum = item._displayNumber || item.item_number;
            const isHighPt = Number(item.points) >= 4;
            return `<span class="matrix-q-pill ${isHighPt ? "pts-4" : ""}" onclick="jumpToItemCard(${index})" title="문항 ${escapeHtml(dispNum)}번 (${item.points}점): ${escapeHtml(item.content_domain?.topic || "")}">${escapeHtml(dispNum)}번 (${item.points}점)</span>`;
          })
          .join("");
        html += `
          <td class="matrix-cell">
            <div class="matrix-item-Group">${pills}</div>
            <div class="matrix-cell-sub">${c}문항 (${pts}점)</div>
          </td>
        `;
      }
    });

    grandCount += rowCount;
    grandPoints += rowPoints;
    const rowRatio = items.length > 0 ? Math.round((rowCount / items.length) * 100) : 0;

    html += `
      <td class="matrix-total-col">
        ${rowCount > 0 ? `${rowCount}문항 / ${rowPoints}점 (${rowRatio}%)` : "-"}
      </td>
    </tr>`;
  });

  html += `
    <tr class="matrix-total-row">
      <th colspan="2">행동영역별 합계</th>
      ${behaviorCols
        .map((bCol) => {
          const ct = colTotals[bCol];
          const ratio = grandCount > 0 ? Math.round((ct.count / grandCount) * 100) : 0;
          return `<td>${ct.count}문항 / ${ct.points}점 (${ratio}%)</td>`;
        })
        .join("")}
      <td>총 ${grandCount}문항 / ${grandPoints}점 (100%)</td>
    </tr>
  </tbody>`;

  table.innerHTML = html;
}

function matchBehaviorColumn(bName, behaviorCols) {
  if (!bName) return null;
  const clean = cleanBehaviorLabel(bName);
  for (const col of behaviorCols) {
    if (col === clean) return col;
    if (col && (clean.includes(col) || col.includes(clean))) return col;
  }
  return null;
}

function findMatchingContentRowKey(major, middle, contentRows) {
  const m1 = (major || "").replace(/\s+/g, "");
  const m2 = (middle || "").replace(/\s+/g, "");
  for (const r of contentRows) {
    const rMaj = r.major.replace(/\s+/g, "");
    const rMid = r.middle.replace(/\s+/g, "");
    if ((rMaj === m1 || rMaj.includes(m1) || m1.includes(rMaj)) && rMid === m2) return r.key;
  }
  for (const r of contentRows) {
    const rMid = r.middle.replace(/\s+/g, "");
    if (rMid && (m2.includes(rMid) || rMid.includes(m2))) return r.key;
  }
  return null;
}

window.jumpToItemCard = function (index) {
  switchTab("tab-items");
  setTimeout(() => {
    const card = document.getElementById(`item-card-${index}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.style.boxShadow = "0 0 0 3px #1e40af";
      setTimeout(() => {
        card.style.boxShadow = "";
      }, 1800);
    }
  }, 80);
};

function renderDistributionCharts(items) {
  // 1. Content Domain (Major) Distribution Chart
  const contentChart = document.getElementById("contentDistChart");
  if (contentChart) {
    const majCounts = {};
    items.forEach((it) => {
      const m = it.content_domain?.major || "기타";
      if (!majCounts[m]) majCounts[m] = { count: 0, points: 0 };
      majCounts[m].count += 1;
      majCounts[m].points += Number(it.points) || 0;
    });

    contentChart.innerHTML = Object.entries(majCounts)
      .map(([mName, stat]) => {
        const pct = items.length > 0 ? Math.round((stat.count / items.length) * 100) : 0;
        return `
          <div class="bar-row">
            <div class="bar-label" title="${escapeHtml(mName)}">${escapeHtml(mName)}</div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${pct}%; background:#4338ca;"></div>
            </div>
            <div class="bar-stat">${stat.count}문항 / ${stat.points}점 (${pct}%)</div>
          </div>
        `;
      })
      .join("");
  }

  // 2. Behavioral Domain Distribution Chart
  const behChart = document.getElementById("behaviorDistChart");
  if (behChart) {
    const behCounts = {};
    items.forEach((it) => {
      const b = cleanBehaviorLabel(it.behavioral_domain?.primary || "기타");
      if (!behCounts[b]) behCounts[b] = { count: 0, points: 0 };
      behCounts[b].count += 1;
      behCounts[b].points += Number(it.points) || 0;
    });

    behChart.innerHTML = Object.entries(behCounts)
      .map(([bName, stat]) => {
        const pct = items.length > 0 ? Math.round((stat.count / items.length) * 100) : 0;
        return `
          <div class="bar-row">
            <div class="bar-label" title="${escapeHtml(bName)}">${escapeHtml(bName)}</div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${pct}%; background:#1e40af;"></div>
            </div>
            <div class="bar-stat">${stat.count}문항 / ${stat.points}점 (${pct}%)</div>
          </div>
        `;
      })
      .join("");
  }
}

/* Render Tab 3: Item Summary Table & Detailed Review Cards */
function populateItemFilters() {
  const fullSetInfo = getActiveFullSetView(state.currentReport);
  const items = fullSetInfo.activeEntries.map((e) => e.item);
  const majorSelect = document.getElementById("filterMajorSelect");
  const behSelect = document.getElementById("filterBehaviorSelect");
  if (!majorSelect || !behSelect) return;

  const majors = Array.from(new Set(items.map((it) => it.content_domain?.major).filter(Boolean)));
  const behaviors = Array.from(
    new Set(items.map((it) => cleanBehaviorLabel(it.behavioral_domain?.primary)).filter(Boolean))
  );

  majorSelect.innerHTML =
    `<option value="ALL">내용영역(대분류): 전체</option>` +
    majors.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

  behSelect.innerHTML =
    `<option value="ALL">행동영역: 전체</option>` +
    behaviors.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
}

function renderItemsView() {
  const fullSetInfo = getActiveFullSetView(state.currentReport);
  const query = (document.getElementById("itemSearchInput")?.value || "").trim().toLowerCase();
  const majorFilter = document.getElementById("filterMajorSelect")?.value || "ALL";
  const behFilter = document.getElementById("filterBehaviorSelect")?.value || "ALL";

  const filtered = fullSetInfo.activeEntries
    .map((e) => ({ item: e.item, idx: e.rawIndex, displayNumber: e.displayNumber }))
    .filter(({ item }) => {
      if (majorFilter !== "ALL" && item.content_domain?.major !== majorFilter) return false;
      if (behFilter !== "ALL" && cleanBehaviorLabel(item.behavioral_domain?.primary) !== behFilter)
        return false;
      if (query) {
        const hay = JSON.stringify(item).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

  // 1. Well-proportioned Summary Table (6 columns matching colgroup)
  const tbody = document.getElementById("itemSummaryTbody");
  if (tbody) {
    tbody.innerHTML = filtered
      .map(({ item, idx, displayNumber }) => {
        const cd = item.content_domain || {};
        const bd = item.behavioral_domain || {};
        const ev = item.evaluation || {};
        const behClean = cleanBehaviorLabel(bd.primary);
        return `
          <tr onclick="jumpToItemCard(${idx})">
            <td class="cell-nowrap"><strong>${escapeHtml(displayNumber || item.item_number)}번</strong></td>
            <td class="cell-nowrap">${escapeHtml(item.points)}점</td>
            <td class="cell-nowrap">${escapeHtml(item.question_type || "5지선다형")}</td>
            <td>
              <strong>${escapeHtml(cd.major)} &rsaquo; ${escapeHtml(cd.middle)}</strong><br/>
              <span style="color:#475569; font-size:13px;">${escapeHtml(cd.topic)}</span>
            </td>
            <td class="cell-nowrap">
              <span class="behavior-badge">${escapeHtml(behClean)}</span>
            </td>
            <td>${escapeHtml(ev.intent_and_key_idea || item.stem_summary || "-")}</td>
          </tr>
        `;
      })
      .join("");
  }

  // 2. Clean Detailed Item Cards (Single Behavioral Domain, No Per-Item Difficulty Clutter)
  const cardsContainer = document.getElementById("itemCardsContainer");
  if (cardsContainer) {
    cardsContainer.innerHTML = filtered
      .map(({ item, idx, displayNumber }) => {
        const cd = item.content_domain || {};
        const bd = item.behavioral_domain || {};
        const ev = item.evaluation || {};
        const behClean = cleanBehaviorLabel(bd.primary);

        return `
          <article id="item-card-${idx}" class="item-detail-card">
            <div class="item-card-top">
              <div class="item-card-title-wrap">
                <span class="item-num-badge">문항 ${escapeHtml(displayNumber || item.item_number)}번</span>
                <span class="item-points-badge">배점 ${escapeHtml(item.points)}점</span>
                <span class="tag tag-gray">${escapeHtml(item.question_type || "5지선다형")}</span>
                <span class="tag tag-blue">행동영역: ${escapeHtml(behClean)}</span>
              </div>
              <div class="no-print" style="display:flex; gap:8px;">
                <button type="button" class="btn btn-outline btn-sm" onclick="openEditModal(${idx})">✏️ 분류·평가 수정</button>
                <button type="button" class="btn btn-danger-outline btn-sm" onclick="deleteItem(${idx})">삭제</button>
              </div>
            </div>

            <div class="item-stem-box">
              <strong>[문항 발문 및 핵심 조건 요약]</strong> ${escapeHtml(item.stem_summary || "-")}
            </div>

            <div class="item-card-grid-2">
              <!-- Content Domain -->
              <div class="domain-box">
                <div class="domain-box-title">📚 내용영역 분류 (${escapeHtml(state.currentCurriculumId)} 개정 교육과정)</div>
                <div class="domain-hierarchy">
                  ${escapeHtml(cd.major || "-")} &rsaquo; ${escapeHtml(cd.middle || "-")} &rsaquo; ${escapeHtml(cd.topic || "-")}
                </div>
                ${cd.achievement_standard ? `<div class="std-badge">${escapeHtml(cd.achievement_standard)}</div>` : ""}
                <p class="domain-rationale"><strong>분류 근거:</strong> ${escapeHtml(cd.rationale || "-")}</p>
              </div>

              <!-- Single Behavioral Domain -->
              <div class="domain-box">
                <div class="domain-box-title">🧠 행동영역 분류 (단일 행동영역)</div>
                <div class="domain-hierarchy">
                  ${escapeHtml(behClean)}
                </div>
                <p class="domain-rationale"><strong>인지 과정 및 분류 근거:</strong> ${escapeHtml(bd.rationale || "-")}</p>
              </div>
            </div>

            <!-- Qualitative Item Evaluation -->
            <div class="item-eval-grid-2">
              <div class="eval-cell">
                <h5>🎯 출제 의도 및 핵심 발상 (Key Idea)</h5>
                <p>${escapeHtml(ev.intent_and_key_idea || "-")}</p>
              </div>
              <div class="eval-cell">
                <h5>🚧 풀이 병목 요인 및 오답 함정 분석</h5>
                <p>${escapeHtml(ev.bottleneck_and_distractors || ev.kice_guideline_fit || "-")}</p>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  }

  triggerMathRender();
}

/* Edit & Delete Item Modal */
window.openEditModal = function (index) {
  state.editingItemIndex = index;
  const isNew = index < 0;
  document.getElementById("editModalTitle").textContent = isNew
    ? "새 문항 분류 및 평가 수동 추가"
    : `문항 ${state.currentReport.items[index].item_number}번 분류 및 평가 수정`;

  const item = isNew
    ? {
        item_number: String((state.currentReport?.items?.length || 0) + 1),
        points: 3,
        question_type: "5지선다형",
        stem_summary: "",
        content_domain: { major: "", middle: "", topic: "", achievement_standard: "", rationale: "" },
        behavioral_domain: { primary: "이해", rationale: "" },
        evaluation: { intent_and_key_idea: "", bottleneck_and_distractors: "" },
      }
    : state.currentReport.items[index];

  document.getElementById("editItemNum").value = item.item_number || "";
  document.getElementById("editItemPoints").value = item.points || 3;
  document.getElementById("editItemType").value = item.question_type || "5지선다형";
  document.getElementById("editItemStem").value = item.stem_summary || "";

  document.getElementById("editContentMajor").value = item.content_domain?.major || "";
  document.getElementById("editContentMiddle").value = item.content_domain?.middle || "";
  document.getElementById("editContentTopic").value = item.content_domain?.topic || "";
  document.getElementById("editContentStd").value = item.content_domain?.achievement_standard || "";
  document.getElementById("editContentRationale").value = item.content_domain?.rationale || "";

  document.getElementById("editBehaviorPrimary").value = cleanBehaviorLabel(item.behavioral_domain?.primary || "");
  document.getElementById("editBehaviorRationale").value = item.behavioral_domain?.rationale || "";

  document.getElementById("editEvalIntent").value = item.evaluation?.intent_and_key_idea || "";
  document.getElementById("editEvalBottleneck").value = item.evaluation?.bottleneck_and_distractors || "";

  document.getElementById("editItemModal")?.classList.remove("hidden");
};

function closeEditModal() {
  document.getElementById("editItemModal")?.classList.add("hidden");
}

function saveEditedItem() {
  if (!state.currentReport) return;
  const idx = state.editingItemIndex;

  const updated = {
    item_number: document.getElementById("editItemNum").value.trim(),
    points: Number(document.getElementById("editItemPoints").value) || 3,
    question_type: document.getElementById("editItemType").value.trim(),
    stem_summary: document.getElementById("editItemStem").value.trim(),
    content_domain: {
      major: document.getElementById("editContentMajor").value.trim(),
      middle: document.getElementById("editContentMiddle").value.trim(),
      topic: document.getElementById("editContentTopic").value.trim(),
      achievement_standard: document.getElementById("editContentStd").value.trim(),
      rationale: document.getElementById("editContentRationale").value.trim(),
    },
    behavioral_domain: {
      primary: document.getElementById("editBehaviorPrimary").value.trim(),
      rationale: document.getElementById("editBehaviorRationale").value.trim(),
    },
    evaluation: {
      intent_and_key_idea: document.getElementById("editEvalIntent").value.trim(),
      bottleneck_and_distractors: document.getElementById("editEvalBottleneck").value.trim(),
    },
  };

  if (idx < 0) {
    state.currentReport.items.push(updated);
  } else {
    state.currentReport.items[idx] = updated;
  }

  closeEditModal();
  setReport(state.currentReport, false);
  showAlert(`문항 ${updated.item_number}번 정보가 업데이트되어 이원목적분류표에 반영되었습니다.`, "success");
}

window.deleteItem = function (idx) {
  if (!state.currentReport?.items) return;
  const num = state.currentReport.items[idx]?.item_number;
  state.currentReport.items.splice(idx, 1);
  setReport(state.currentReport, false);
  showAlert(`문항 ${num}번이 삭제되었습니다.`, "info");
};

/* Render Tab 4: Dedicated Report Archive (#tab-history) */
function renderHistoryArchive() {
  const gridEl = document.getElementById("historyArchiveGrid");
  const countEl = document.getElementById("navHistoryCount");
  if (countEl) countEl.textContent = String(state.history?.length || 0);
  if (!gridEl) return;

  if (!state.history || state.history.length === 0) {
    gridEl.innerHTML = `<div class="empty-hint">아직 저장된 분석 리포트가 없습니다. 시험지를 분석하면 이곳 보관함에 자동 저장됩니다.</div>`;
    return;
  }

  gridEl.innerHTML = state.history
    .map((entry, idx) => {
      const fullSetInfo = entry.report ? getActiveFullSetView(entry.report) : null;
      const countLabel =
        fullSetInfo && fullSetInfo.isFullMockExam
          ? `${fullSetInfo.activeEntries.length}문항·100점 풀세트 (${fullSetInfo.availableElectives.join("·")})`
          : `${entry.item_count}문항`;
      return `
        <div class="history-card">
          <div>
            <div class="history-card-title">${escapeHtml(entry.exam_title)}</div>
            <div class="history-card-tags">
              <span class="tag tag-blue">${escapeHtml(entry.curriculum_name || "2015 개정")}</span>
              <span class="tag tag-indigo">${escapeHtml(entry.subject_name || "수학 영역")}</span>
              <span class="tag tag-gray">${escapeHtml(countLabel)}</span>
            </div>
          </div>
          <div class="history-card-footer">
            <span class="text-muted">${escapeHtml(entry.created_at || "")}</span>
            <div style="display:flex; gap:8px;">
              <button type="button" class="btn btn-primary btn-sm" onclick="loadHistoryEntry(${idx})">📊 리포트 열기</button>
              <button type="button" class="btn btn-danger-outline btn-sm" onclick="deleteHistoryEntry(${idx}, '${escapeHtml(entry.id || "")}')">삭제</button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

window.loadHistoryEntry = function (idx) {
  const entry = state.history[idx];
  if (entry && entry.report) {
    setReport(entry.report, true);
    showAlert(`보관함에서 '${entry.exam_title}' 리포트를 불러왔습니다.`, "success");
  }
};

window.deleteHistoryEntry = async function (idx, entryId) {
  try {
    const res = await fetch("/api/history/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: idx, id: entryId }),
    });
    const json = await res.json();
    if (json.ok) {
      state.history = json.reports || [];
      renderHistoryArchive();
      showAlert("선택한 분석 리포트가 보관함에서 삭제되었습니다.", "info");
    }
  } catch (err) {
    showAlert(`리포트 삭제 실패: ${err.message}`, "error");
  }
};

/* Render Tab 5: KICE Framework Viewer & Editor (Includes Delete Custom Subject!) */
function renderFrameworkEditor() {
  const fw = state.frameworksData;
  if (!fw) return;

  const principlesEl = document.getElementById("commonPrinciplesList");
  if (principlesEl) {
    principlesEl.innerHTML = (fw.guidelines_common?.principles || [])
      .map((p) => `<div class="principle-item">${escapeHtml(p)}</div>`)
      .join("");
  }

  const gradeEl = document.getElementById("gradeCriteriaList");
  const gradesObj = fw.guidelines_common?.grade_levels || {};
  if (gradeEl) {
    gradeEl.innerHTML = Object.values(gradesObj)
      .map(
        (g) => `
        <div class="criteria-card" style="${g.id === state.currentGradeId ? "border-color:#1e40af; background:#eff6ff;" : ""}">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">
            <strong>🎓 ${escapeHtml(g.name)}</strong>
            <span class="tag tag-blue">자동 연동: ${escapeHtml(g.default_curriculum)} 개정 교육과정</span>
          </div>
          <p style="font-size:13px; color:#334155; margin-bottom:4px;">• <strong>전체 난이도 진단 기준:</strong> ${escapeHtml(g.difficulty_calibration)}</p>
          <p style="font-size:12.5px; color:#475569;">• <strong>시험 범위 점검:</strong> ${escapeHtml(g.scope_check_rule)}</p>
        </div>
      `
      )
      .join("");
  }

  const subj = getCurrentSubjectFramework();
  if (!subj) return;

  const currName =
    fw.guidelines_common?.curriculums?.[state.currentCurriculumId]?.name ||
    `${state.currentCurriculumId} 개정 교육과정`;

  document.getElementById("fwEditorTitle").textContent = `${subj.name} — [${currName}] 평가틀 설정`;
  const secHeader = document.getElementById("fwContentSectionHeader");
  if (secHeader) {
    secHeader.textContent = `1. 내용영역 (${currName}) 단원 및 성취기준 체계`;
  }

  // Show/enable Delete button clearly
  const delBtn = document.getElementById("deleteCustomSubjectBtn");
  if (delBtn) {
    const isBuiltin = BUILTIN_SUBJECT_IDS.has(subj.id);
    delBtn.textContent = isBuiltin ? "🗑️ 과목 삭제 (기본과목 보호됨)" : `🗑️ '${subj.name}' 과목 삭제`;
  }

  const activeDomains = getActiveContentDomains(subj, state.currentCurriculumId);
  const contEditor = document.getElementById("fwContentEditor");
  if (contEditor) {
    contEditor.innerHTML = activeDomains
      .map(
        (c) => `
        <div class="fw-domain-item">
          <div style="font-weight:700; font-size:14.5px; color:#0f172a; margin-bottom:8px;">📘 대분류: ${escapeHtml(c.major)}</div>
          ${(c.middle || [])
            .map(
              (m) => `
            <div style="margin-left:10px; margin-bottom:6px; font-size:13px;">
              <strong>• ${escapeHtml(m.name)}:</strong>
              <span style="color:#475569;">${(m.topics || []).map(escapeHtml).join(", ")}</span>
            </div>
          `
            )
            .join("")}
        </div>
      `
      )
      .join("");
  }

  const behEditor = document.getElementById("fwBehavioralEditor");
  if (behEditor) {
    behEditor.innerHTML = (subj.behavioral_domains || [])
      .map(
        (b) => `
        <div class="fw-domain-item">
          <div style="font-weight:700; color:#1e40af; margin-bottom:4px;">[${escapeHtml(b.code)}] ${escapeHtml(b.name)}</div>
          <div style="font-size:13px; margin-bottom:4px;"><strong>정의:</strong> ${escapeHtml(b.definition)}</div>
          <div style="font-size:12.5px; color:#475569;"><strong>판별 지표:</strong> ${(b.indicators || []).map(escapeHtml).join(" / ")}</div>
        </div>
      `
      )
      .join("");
  }

  const rawArea = document.getElementById("fwRawJsonTextarea");
  if (rawArea) {
    rawArea.value = JSON.stringify(subj, null, 2);
  }
}

async function saveCustomFramework() {
  try {
    const rawJson = document.getElementById("fwRawJsonTextarea").value;
    const parsedSubj = JSON.parse(rawJson);
    if (!parsedSubj.id || !parsedSubj.name) {
      throw new Error("과목 JSON에 id와 name 필드가 필요합니다.");
    }
    state.frameworksData.subjects[parsedSubj.id] = parsedSubj;
    state.currentSubjectId = parsedSubj.id;

    const res = await fetch("/api/frameworks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frameworks: state.frameworksData }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);

    populateSubjectSelect();
    renderActiveFrameworkBanner();
    renderFrameworkEditor();
    showAlert(`'${parsedSubj.name}' 평가틀이 저장되었습니다.`, "success");
  } catch (err) {
    showAlert(`평가틀 저장 오류: ${err.message}`, "error");
  }
}

async function addNewCustomSubject() {
  const newId = `custom_${Date.now().toString().slice(-4)}`;
  const template = {
    id: newId,
    name: "사용자 정의 과목 영역",
    subtitle: "커스텀 교육과정 내용영역 및 단일 행동영역",
    total_items_standard: 20,
    point_types: [2, 3],
    content_domains: [
      {
        major: "대단원 I",
        middle: [
          { name: "중단원 1", topics: ["핵심 개념 A", "핵심 개념 B"] },
          { name: "중단원 2", topics: ["핵심 개념 C"] },
        ],
      },
    ],
    behavioral_domains: [
      { code: "UND", name: "개념 이해", definition: "기본 개념과 원리를 이해하는 능력", indicators: ["정의 및 기본 원리 확인 문항"] },
      { code: "INF", name: "자료 분석 및 추론", definition: "제시된 자료를 해석하고 추론하는 능력", indicators: ["표·그래프·사례 추론 문항"] },
      { code: "APP", name: "적용 및 문제해결", definition: "개념을 새로운 상황에 적용하여 해결하는 능력", indicators: ["심화 융합 문제해결 문항"] },
    ],
  };
  state.frameworksData.subjects[newId] = template;
  state.currentSubjectId = newId;

  await fetch("/api/frameworks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ frameworks: state.frameworksData }),
  }).catch(() => {});

  populateSubjectSelect();
  syncElectiveDropdownOptions();
  renderActiveFrameworkBanner();
  renderFrameworkEditor();
  showAlert("새 사용자정의 과목이 추가되었습니다. 삭제하려면 우측 상단 [🗑️ 과목 삭제] 버튼을 누르세요.", "success");
}

async function deleteCurrentSubject() {
  const subj = getCurrentSubjectFramework();
  if (!subj) return;

  if (BUILTIN_SUBJECT_IDS.has(subj.id)) {
    showAlert(
      `'${subj.name}'은(는) KICE 기본 제공 과목이므로 삭제할 수 없습니다. (+ 사용자정의 과목 추가로 생성한 과목만 삭제 가능합니다)`,
      "error"
    );
    return;
  }

  const deletedName = subj.name;
  delete state.frameworksData.subjects[subj.id];
  const remainingIds = Object.keys(state.frameworksData.subjects);
  state.currentSubjectId = remainingIds[0] || "math";

  try {
    const res = await fetch("/api/frameworks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frameworks: state.frameworksData }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);

    populateSubjectSelect();
    syncElectiveDropdownOptions();
    renderActiveFrameworkBanner();
    renderFrameworkEditor();
    showAlert(`사용자정의 과목 '${deletedName}'이(가) 삭제되었습니다.`, "success");
  } catch (err) {
    showAlert(`과목 삭제 저장 중 오류: ${err.message}`, "error");
  }
}

/* Export Functions: Excel (.xlsx), CSV, JSON */
function exportToExcel() {
  const rep = state.currentReport;
  if (!rep || !Array.isArray(rep.items) || rep.items.length === 0) {
    showAlert("내보낼 문항 분석 결과가 없습니다.", "error");
    return;
  }
  if (!window.XLSX) {
    exportToCsv();
    return;
  }

  const fullSetInfo = getActiveFullSetView(rep);
  const activeItems = fullSetInfo.activeEntries.map((e) => ({
    ...e.item,
    _displayNumber: e.displayNumber,
  }));
  const totalPts = activeItems.reduce((a, it) => a + (Number(it.points) || 0), 0);
  const { overallDiffText, challengingList } = getSynthesizedOverallDifficultyAndChallenging(rep, activeItems);

  const wb = window.XLSX.utils.book_new();

  const itemRows = activeItems.map((it) => ({
    "문항 번호": it._displayNumber || it.item_number,
    "배점": it.points,
    "문항 형태": it.question_type || "",
    "적용 교육과정": rep.curriculum_name || `${state.currentCurriculumId} 개정 교육과정`,
    "대상 학년": rep.target_grade || "",
    "내용영역(대분류)": it.content_domain?.major || "",
    "내용영역(중분류)": it.content_domain?.middle || "",
    "소분류/핵심개념": it.content_domain?.topic || "",
    "교육과정 성취기준": it.content_domain?.achievement_standard || "",
    "내용영역 분류근거": it.content_domain?.rationale || "",
    "행동영역": cleanBehaviorLabel(it.behavioral_domain?.primary || ""),
    "행동영역 분류근거": it.behavioral_domain?.rationale || "",
    "발문 및 조건 요약": it.stem_summary || "",
    "출제의도 및 핵심발상": it.evaluation?.intent_and_key_idea || "",
    "풀이 병목 및 오답요인": it.evaluation?.bottleneck_and_distractors || "",
  }));
  const wsItems = window.XLSX.utils.json_to_sheet(itemRows);
  window.XLSX.utils.book_append_sheet(wb, wsItems, "1_문항별분류표");

  const matrixTableEl = document.getElementById("twoWayMatrixTable");
  if (matrixTableEl) {
    const wsMatrix = window.XLSX.utils.table_to_sheet(matrixTableEl);
    window.XLSX.utils.book_append_sheet(wb, wsMatrix, "2_이원목적분류표");
  }

  const summaryRows = [
    { 항목: "시험지 제목", 내용: rep.exam_title || "" },
    { 항목: "적용 교육과정", 내용: rep.curriculum_name || "" },
    { 항목: "대상 학년", 내용: rep.target_grade || "" },
    { 항목: "대상 과목", 내용: rep.subject_name || "" },
    { 항목: "문항 수 / 총점", 내용: `${activeItems.length}문항 / ${totalPts}점` },
    { 항목: "시험 전체 출제 총평", 내용: rep.overall_evaluation?.summary || "" },
    { 항목: "시험 전체 난이도 분석", 내용: overallDiffText },
    {
      항목: "주요 고난도·변별 문항 분석",
      내용: challengingList.map((c) => `[${c.item_number}번: ${c.topic}] ${c.reason}`).join(" / "),
    },
    { 항목: "내용영역 균형성 검토", 내용: rep.overall_evaluation?.content_balance_review || "" },
    { 항목: "행동영역 균형성 검토", 내용: rep.overall_evaluation?.behavioral_balance_review || "" },
  ];
  const wsSummary = window.XLSX.utils.json_to_sheet(summaryRows);
  window.XLSX.utils.book_append_sheet(wb, wsSummary, "3_전체난이도및종합총평");

  const safeTitle = (rep.exam_title || "수능문항분류").replace(/[\\/:*?"<>|]/g, "_");
  trackUsage("Excel 내보내기", {
    exam_title: rep.exam_title || "",
    item_count: activeItems.length,
  });
  window.XLSX.writeFile(wb, `${safeTitle}_KICE문항분류리포트.xlsx`);
}

function exportToCsv() {
  const rep = state.currentReport;
  if (!rep || !Array.isArray(rep.items) || rep.items.length === 0) {
    showAlert("내보낼 문항 분석 결과가 없습니다.", "error");
    return;
  }

  const fullSetInfo = getActiveFullSetView(rep);
  const activeItems = fullSetInfo.activeEntries.map((e) => ({
    ...e.item,
    _displayNumber: e.displayNumber,
  }));

  const headers = [
    "문항번호",
    "배점",
    "문항형태",
    "교육과정",
    "내용영역_대분류",
    "내용영역_중분류",
    "핵심개념",
    "성취기준",
    "행동영역",
    "행동영역_분류근거",
    "출제의도및핵심발상",
    "병목및오답요인",
  ];

  const rows = activeItems.map((it) => [
    it._displayNumber || it.item_number,
    it.points,
    it.question_type || "",
    rep.curriculum_name || "",
    it.content_domain?.major || "",
    it.content_domain?.middle || "",
    it.content_domain?.topic || "",
    it.content_domain?.achievement_standard || "",
    cleanBehaviorLabel(it.behavioral_domain?.primary || ""),
    it.behavioral_domain?.rationale || "",
    it.evaluation?.intent_and_key_idea || "",
    it.evaluation?.bottleneck_and_distractors || "",
  ]);

  const csvLines = [
    headers.join(","),
    ...rows.map((r) => r.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")),
  ];
  const blob = new Blob(["\uFEFF" + csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(rep.exam_title || "문항분류").replace(/\s+/g, "_")}.csv`;
  trackUsage("CSV 내보내기", {
    exam_title: rep.exam_title || "",
    item_count: activeItems.length,
  });
  a.click();
  URL.revokeObjectURL(url);
}

function exportToJson() {
  if (!state.currentReport) {
    showAlert("내보낼 리포트 데이터가 없습니다.", "error");
    return;
  }
  const blob = new Blob([JSON.stringify(state.currentReport, null, 2)], {
    type: "application/json;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(state.currentReport.exam_title || "report").replace(/\s+/g, "_")}.json`;
  trackUsage("JSON 리포트 저장", {
    exam_title: state.currentReport.exam_title || "",
    item_count: state.currentReport.items?.length || 0,
  });
  a.click();
  URL.revokeObjectURL(url);
}
