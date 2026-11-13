/* =========================================================
   日序 DayFlow — application
   A local-first planner: natural-language capture, auto-scheduling,
   task inbox, and reminders (native + optional chat webhooks).
   ========================================================= */

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // constants & state

  const LS_KEY = "dayflow.state.v2";
  const CLOUD_MODE = Boolean(window.DAYFLOW_CLOUD_MODE);
  const AI_KEY_STORAGE = "dayflow.ai.key";
  const AI_MODEL_STORAGE = "dayflow.ai.model";
  const AI_ENABLED_STORAGE = "dayflow.ai.enabled";
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  const WEEKDAYS_EN = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const CATEGORY_LABELS = { work: "工作", study: "学习", life: "生活", health: "健康", other: "其他" };
  const CATEGORY_ORDER = ["work", "study", "life", "health", "other"];
  const PRIORITY_LABELS = { 1: "紧急", 2: "重要", 3: "" };
  const HOUR_HEIGHT_DAY = 68;
  const HOUR_HEIGHT_WEEK = 60;
  const WEEK_START_HOUR = 7;
  const WEEK_END_HOUR = 22;

  const DEFAULT_SETTINGS = {
    userName: "朋友",
    workStart: "09:00",
    workEnd: "18:30",
    lunchStart: "12:00",
    lunchEnd: "13:30",
    eveningEnabled: true,
    eveningStart: "19:30",
    eveningEnd: "21:30",
    dailyCapacity: 300,
    defaultLead: 15,
    defaultDuration: 45,
    buffer: 10,
    nativeEnabled: true,
    sound: true,
    deadlineReminder: true,
    deadlineLead: 120,
    quietEnabled: false,
    quietStart: "22:00",
    quietEnd: "08:00",
    semesterStart: "2026-08-31",
    semesterWeeks: 19,
    webhook: { enabled: false, type: "auto", url: "", secret: "" }
  };

  let state = null;
  let serverMode = false;
  let serverMeta = null;
  let currentView = "today";
  let dayDate = todayKey();
  let weekStartKey = dateKey(startOfWeek(new Date()));
  let parsedDrafts = [];
  let parsedActions = [];
  let managementReply = "";
  let captureMode = "add";
  let voiceRecognition = null;
  let currentMode = "auto";
  let currentCategory = "work";
  let currentPriority = 2;
  let editingTaskId = null;
  let taskFilter = { status: "open", category: "all", query: "" };
  let serverEvents = [];
  let eventCursor = 0;
  let pollTimer = null;
  let localTimer = null;
  let clockTimer = null;
  let saveTimer = null;
  let saveResetTimer = null;
  let lastWeekRender = "";
  let confirmResolver = null;
  let audioContext = null;

  // ---------------------------------------------------------------------------
  // tiny helpers

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  function pad2(n) { return String(n).padStart(2, "0"); }
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const uid = (prefix = "t") => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  function dateKey(value = new Date()) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function keyDate(key) {
    if (!key) return null;
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function startOfDay(value = new Date()) {
    const d = value instanceof Date ? new Date(value) : new Date(value);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(value, amount) {
    const d = new Date(value);
    d.setDate(d.getDate() + amount);
    return d;
  }

  function addDaysKey(key, amount) {
    return dateKey(addDays(keyDate(key), amount));
  }

  function startOfWeek(value = new Date()) {
    const d = startOfDay(value);
    const offset = (d.getDay() + 6) % 7; // Monday = 0
    return addDays(d, -offset);
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function parseDateTime(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function toLocalInput(value) {
    if (!value) return "";
    return String(value).slice(0, 16);
  }

  function minutesFromTime(value, fallback = 9 * 60) {
    if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return fallback;
    const [h, m] = value.split(":").map(Number);
    if (h > 23 || m > 59) return fallback;
    return h * 60 + m;
  }

  function timeFromMinutes(minutes) {
    const safe = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${pad2(Math.floor(safe / 60))}:${pad2(safe % 60)}`;
  }

  function combineDateTime(key, minutes) {
    return `${key}T${timeFromMinutes(minutes)}`;
  }

  function sameDay(value, key = todayKey()) {
    const d = value instanceof Date ? value : parseDateTime(value);
    return Boolean(d && dateKey(d) === key);
  }

  function weekdayLabel(key, short = true) {
    const d = keyDate(key);
    if (!d) return "";
    return `${short ? "周" : "星期"}${WEEKDAYS[d.getDay()]}`;
  }

  function dayLabel(key) {
    const today = todayKey();
    if (key === today) return "今天";
    if (key === addDaysKey(today, 1)) return "明天";
    if (key === addDaysKey(today, 2)) return "后天";
    if (key === addDaysKey(today, -1)) return "昨天";
    return weekdayLabel(key);
  }

  function dateLabel(key) {
    const d = keyDate(key);
    return d ? `${d.getMonth() + 1}月${d.getDate()}日` : "";
  }

  function shortDate(key) {
    const d = keyDate(key);
    return d ? `${d.getMonth() + 1}/${d.getDate()}` : "";
  }

  function fullDayLabel(key) {
    return `${dateLabel(key)} ${weekdayLabel(key)}`;
  }

  function relativeMinutes(value) {
    const target = value instanceof Date ? value : parseDateTime(value);
    if (!target) return 0;
    return Math.round((target.getTime() - Date.now()) / 60000);
  }

  function stripSeconds(value) {
    return value ? String(value).slice(0, 16) : "";
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 5) return "夜深了";
    if (hour < 11) return "早上好";
    if (hour < 13) return "中午好";
    if (hour < 18) return "下午好";
    return "晚上好";
  }

  function saveIndicator(text, mode = "") {
    const el = $("#saveState");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-saving", mode === "saving");
    el.classList.toggle("is-error", mode === "error");
    clearTimeout(saveResetTimer);
    if (mode !== "saving") {
      saveResetTimer = setTimeout(() => {
        el.textContent = serverMode ? "已保存" : "本地保存";
        el.classList.remove("is-saving", "is-error");
      }, 2200);
    }
  }

  function setButtonBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.innerHTML;
      button.disabled = true;
      if (label) button.textContent = label;
    } else {
      button.disabled = false;
      if (button.dataset.originalLabel) {
        button.innerHTML = button.dataset.originalLabel;
        delete button.dataset.originalLabel;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // state normalization / persistence

  function defaultState() {
    return {
      version: 2,
      tasks: [],
      settings: { ...DEFAULT_SETTINGS, webhook: { ...DEFAULT_SETTINGS.webhook } },
      meta: {
        seeded: false,
        demo: false,
        demoBannerDismissed: false,
        revision: 0,
        notified: [],
        events: [],
        createdAt: new Date().toISOString()
      }
    };
  }

  function normalizeSettings(raw) {
    const merged = { ...DEFAULT_SETTINGS, webhook: { ...DEFAULT_SETTINGS.webhook } };
    if (raw && typeof raw === "object") {
      Object.keys(raw).forEach((key) => {
        if (key === "webhook" && raw.webhook && typeof raw.webhook === "object") {
          merged.webhook = { ...merged.webhook, ...raw.webhook };
        } else if (hasOwn(merged, key)) {
          merged[key] = raw[key];
        }
      });
    }
    ["defaultLead", "defaultDuration", "dailyCapacity", "buffer", "deadlineLead"].forEach((key) => {
      const n = Number(merged[key]);
      merged[key] = Number.isFinite(n) ? n : DEFAULT_SETTINGS[key];
    });
    ["nativeEnabled", "sound", "deadlineReminder", "quietEnabled", "eveningEnabled"].forEach((key) => {
      merged[key] = Boolean(merged[key]);
    });
    merged.webhook.enabled = Boolean(merged.webhook.enabled);
    merged.webhook.url = String(merged.webhook.url || "");
    merged.webhook.secret = String(merged.webhook.secret || "");
    merged.webhook.type = String(merged.webhook.type || "auto");
    return merged;
  }

  function normalizeTask(raw) {
    if (!raw || typeof raw !== "object" || !raw.title) return null;
    const start = typeof raw.start === "string" && raw.start ? stripSeconds(raw.start) : null;
    const end = typeof raw.end === "string" && raw.end ? stripSeconds(raw.end) : null;
    // A fixed task without a real start time cannot be pinned; let the planner place it.
    const fixed = Boolean(raw.fixed && start);
    const estimateRaw = Number(raw.estimate);
    const estimate = Number.isFinite(estimateRaw) ? clamp(estimateRaw, 5, 720) : 45;
    const category = CATEGORY_LABELS[raw.category] ? raw.category : "other";
    const priority = [1, 2, 3].includes(Number(raw.priority)) ? Number(raw.priority) : 2;
    return {
      id: raw.id || uid(),
      title: String(raw.title).slice(0, 120),
      notes: String(raw.notes || "").slice(0, 1000),
      category,
      priority,
      estimate,
      fixed,
      start,
      end,
      course: Boolean(raw.course),
      deadline: typeof raw.deadline === "string" && raw.deadline ? stripSeconds(raw.deadline) : null,
      availableFrom: typeof raw.availableFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.availableFrom) ? raw.availableFrom : null,
      reminderLead: raw.reminderLead === null || raw.reminderLead === undefined || raw.reminderLead === "" ? null : clamp(Number(raw.reminderLead), 0, 2880),
      done: Boolean(raw.done),
      completedAt: raw.completedAt || null,
      createdAt: raw.createdAt || new Date().toISOString(),
      demo: Boolean(raw.demo),
      planWarning: Boolean(raw.planWarning)
    };
  }

  function normalizeState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== "object") return base;
    const normalized = {
      ...base,
      ...raw,
      version: 2,
      settings: normalizeSettings(raw.settings),
      tasks: Array.isArray(raw.tasks) ? raw.tasks.map(normalizeTask).filter(Boolean) : [],
      meta: { ...base.meta, ...(raw.meta && typeof raw.meta === "object" ? raw.meta : {}) }
    };
    if (!Array.isArray(normalized.meta.notified)) normalized.meta.notified = [];
    if (!Array.isArray(normalized.meta.events)) normalized.meta.events = [];
    normalized.meta.revision = Number.isFinite(Number(normalized.meta.revision)) ? Number(normalized.meta.revision) : 0;
    if (!normalized.meta.createdAt) normalized.meta.createdAt = new Date().toISOString();
    return normalized;
  }

  function loadLocalState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? normalizeState(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  function cacheLocalState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      /* storage can be unavailable in private modes */
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      ...options
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function saveState({ immediate = false } = {}) {
    if (!state) return;
    cacheLocalState();
    if (!serverMode) {
      saveIndicator("本地保存");
      return;
    }
    saveIndicator("保存中…", "saving");
    clearTimeout(saveTimer);
    const perform = async () => {
      try {
        await api("/api/state", {
          method: "PUT",
          body: JSON.stringify({ state })
        });
        saveIndicator("已保存");
      } catch (error) {
        saveIndicator("保存失败", "error");
        console.warn("DayFlow save failed", error);
      }
    };
    if (immediate) perform();
    else saveTimer = setTimeout(perform, 280);
  }

  // ---------------------------------------------------------------------------
  // demo data

  function taskTemplate(partial) {
    return normalizeTask({
      id: uid(),
      createdAt: new Date().toISOString(),
      done: false,
      fixed: false,
      priority: 2,
      category: "work",
      estimate: 45,
      notes: "",
      demo: true,
      ...partial
    });
  }

  function seedDemo() {
    const now = new Date();
    const today = todayKey();
    const tomorrow = addDaysKey(today, 1);
    const inTwo = addDaysKey(today, 2);
    const inThree = addDaysKey(today, 3);

    const meetingDay = now.getHours() < 14 ? today : tomorrow;
    const evening = now.getHours() >= 21;

    const tasks = [
      taskTemplate({
        title: "产品周会 · 设计方案评审",
        category: "work",
        priority: 2,
        estimate: 90,
        fixed: true,
        start: combineDateTime(meetingDay, 14 * 60),
        end: combineDateTime(meetingDay, 15 * 60 + 30),
        notes: "会议室 B · 带上上周的数据和两版方案"
      }),
      taskTemplate({
        title: "回复项目邮件与消息",
        category: "work",
        priority: 2,
        estimate: 40,
        deadline: combineDateTime(evening ? tomorrow : today, 18 * 60 + 30),
        notes: "先处理需要别人等待的部分"
      }),
      taskTemplate({
        title: "整理本周数据复盘",
        category: "work",
        priority: 1,
        estimate: 50,
        deadline: combineDateTime(evening ? tomorrow : today, 19 * 60),
        notes: "把关键指标和异常点写成三行结论"
      }),
      taskTemplate({
        title: "夜跑 3 公里",
        category: "health",
        priority: 3,
        estimate: 40,
        fixed: true,
        start: combineDateTime(today, 19 * 60 + 30),
        end: combineDateTime(today, 20 * 60 + 10),
        notes: "小区外环 · 轻松跑，不追配速"
      }),
      taskTemplate({
        title: "完成市场调研初稿",
        category: "study",
        priority: 1,
        estimate: 90,
        deadline: combineDateTime(tomorrow, 18 * 60),
        notes: "先搭结构，再补数据和引用"
      }),
      taskTemplate({
        title: "牙科复诊",
        category: "life",
        priority: 2,
        estimate: 30,
        fixed: true,
        start: combineDateTime(tomorrow, 15 * 60),
        end: combineDateTime(tomorrow, 15 * 60 + 30),
        notes: "提前十分钟到，带医保卡"
      }),
      taskTemplate({
        title: "提交课程作业",
        category: "study",
        priority: 2,
        estimate: 75,
        deadline: combineDateTime(inTwo, 20 * 60),
        notes: "提交前再检查一次引用格式"
      }),
      taskTemplate({
        title: "给家里打电话",
        category: "life",
        priority: 3,
        estimate: 20,
        fixed: true,
        start: combineDateTime(inThree, 20 * 60),
        end: combineDateTime(inThree, 20 * 60 + 20)
      })
    ];

    state.tasks = tasks.filter(Boolean);
    state.meta.seeded = true;
    state.meta.demo = true;
    state.meta.demoBannerDismissed = false;
    state.meta.createdAt = new Date().toISOString();
  }

  // ---------------------------------------------------------------------------
  // scheduling engine

  function getBusyIntervals(dayKeyValue) {
    const busy = [];
    state.tasks.forEach((task) => {
      if (!task.start) return;
      const start = parseDateTime(task.start);
      const end = parseDateTime(task.end) || (start ? new Date(start.getTime() + (task.estimate || 45) * 60000) : null);
      if (!start || !end) return;
      if (dateKey(start) !== dayKeyValue) return;
      if (!task.done && !task.fixed) return;
      const startMin = start.getHours() * 60 + start.getMinutes();
      const endMin = end.getHours() * 60 + end.getMinutes() + (dateKey(end) !== dateKey(start) ? 1440 : 0);
      if (endMin > startMin) busy.push([startMin, endMin]);
    });
    return busy;
  }

  function workWindows(task) {
    const settings = state.settings;
    const start = minutesFromTime(settings.workStart, 9 * 60);
    const end = minutesFromTime(settings.workEnd, 18 * 60 + 30);
    const lunchStart = minutesFromTime(settings.lunchStart, 12 * 60);
    const lunchEnd = minutesFromTime(settings.lunchEnd, 13 * 60 + 30);
    const windows = [];
    if (end <= start) return windows;
    if (lunchStart > start && lunchStart < end) {
      windows.push([start, Math.min(end, lunchStart)]);
      if (lunchEnd < end && lunchEnd > lunchStart) windows.push([Math.max(start, lunchEnd), end]);
    } else {
      windows.push([start, end]);
    }
    if (settings.eveningEnabled && ["life", "health"].includes(task.category)) {
      const eveningStart = minutesFromTime(settings.eveningStart, 19 * 60 + 30);
      const eveningEnd = minutesFromTime(settings.eveningEnd, 21 * 60 + 30);
      if (eveningEnd > eveningStart) windows.push([eveningStart, eveningEnd]);
    }
    return windows.filter(([s, e]) => e > s);
  }

  function subtractIntervals(windows, busy) {
    let slots = windows.map(([start, end]) => [start, end]);
    busy.forEach(([bStart, bEnd]) => {
      const next = [];
      slots.forEach(([start, end]) => {
        if (bEnd <= start || bStart >= end) {
          next.push([start, end]);
          return;
        }
        if (bStart > start) next.push([start, Math.min(end, bStart)]);
        if (bEnd < end) next.push([Math.max(start, bEnd), end]);
      });
      slots = next;
    });
    return slots.filter(([start, end]) => end - start >= 10).sort((a, b) => a[0] - b[0]);
  }

  function taskUrgency(task) {
    const deadline = parseDateTime(task.deadline);
    return deadline ? deadline.getTime() : Number.MAX_SAFE_INTEGER;
  }

  function autoPlan() {
    if (!state) return { scheduled: 0, unscheduled: 0 };
    const settings = state.settings;
    const now = new Date();
    const today = todayKey();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const horizon = 21;
    const days = [];
    for (let i = 0; i < horizon; i += 1) days.push(addDaysKey(today, i));

    const busyByDay = {};
    days.forEach((key) => {
      busyByDay[key] = getBusyIntervals(key);
    });

    const flexible = state.tasks.filter((task) => !task.done && !task.fixed);
    flexible.forEach((task) => {
      task.start = null;
      task.end = null;
      task.planWarning = false;
    });

    const sorted = flexible.slice().sort((a, b) => {
      const deadlineA = parseDateTime(a.deadline);
      const deadlineB = parseDateTime(b.deadline);
      const overdueA = deadlineA && deadlineA < now ? 0 : 1;
      const overdueB = deadlineB && deadlineB < now ? 0 : 1;
      if (overdueA !== overdueB) return overdueA - overdueB;
      const urgencyA = deadlineA ? deadlineA.getTime() : Number.MAX_SAFE_INTEGER;
      const urgencyB = deadlineB ? deadlineB.getTime() : Number.MAX_SAFE_INTEGER;
      if (urgencyA !== urgencyB) return urgencyA - urgencyB;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });

    const used = {};
    days.forEach((key) => { used[key] = 0; });
    const capacity = clamp(Number(settings.dailyCapacity) || 300, 30, 960);
    let scheduled = 0;
    let unscheduled = 0;

    sorted.forEach((task) => {
      const estimate = clamp(Number(task.estimate) || Number(settings.defaultDuration) || 45, 15, 240);
      const deadline = parseDateTime(task.deadline);
      // An already-overdue task should still get a slot; the deadline chip
      // already warns the user, and leaving it forever unscheduled helps nobody.
      const activeDeadline = deadline && deadline >= now ? deadline : null;
      const deadlineDay = activeDeadline ? dateKey(activeDeadline) : null;
      const deadlineMin = activeDeadline ? activeDeadline.getHours() * 60 + activeDeadline.getMinutes() : null;
      const earliest = task.availableFrom && /^\d{4}-\d{2}-\d{2}$/.test(task.availableFrom) && task.availableFrom > today
        ? task.availableFrom
        : today;
      let placed = false;

      for (const day of days) {
        if (day < earliest) continue;
        if (deadlineDay && day > deadlineDay) break;
        if (day === today && nowMinutes >= 23 * 60 + 30) break;
        if (used[day] > 0 && used[day] + estimate > capacity) continue;

        const windows = workWindows(task);
        const slots = subtractIntervals(windows, busyByDay[day] || []);
        for (const [slotStart, slotEnd] of slots) {
          let startMin = Math.max(slotStart, day === today ? Math.ceil((nowMinutes + 5) / 5) * 5 : 0);
          if (startMin + estimate > slotEnd) continue;
          startMin = Math.ceil(startMin / 5) * 5;
          let endMin = startMin + estimate;
          if (endMin > slotEnd) continue;
          if (day === deadlineDay && deadlineMin !== null && endMin > deadlineMin - 5) continue;
          if (endMin > 24 * 60) continue;

          task.start = combineDateTime(day, startMin);
          task.end = combineDateTime(day, endMin);
          task.planWarning = false;
          scheduled += 1;
          placed = true;
          used[day] += estimate;
          const buffer = clamp(Number(settings.buffer) || 0, 0, 60);
          busyByDay[day] = (busyByDay[day] || []).concat([[startMin, endMin + buffer]]);
          break;
        }
        if (placed) break;
      }

      if (!placed) {
        unscheduled += 1;
        task.start = null;
        task.end = null;
        task.planWarning = true;
      }
    });

    state.meta.lastPlanAt = new Date().toISOString();
    return { scheduled, unscheduled };
  }

  // ---------------------------------------------------------------------------
  // natural language parsing

  const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  function cnToNumber(text) {
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text);
    let total = 0;
    let current = 0;
    for (const ch of text) {
      if (ch === "十") {
        total += (current || 1) * 10;
        current = 0;
      } else if (hasOwn(CN_DIGITS, ch)) {
        current = CN_DIGITS[ch];
      }
    }
    total += current;
    return total > 0 ? total : null;
  }

  function periodFromPrefix(prefix) {
    if (/晚上|晚间|傍晚|今晚|明晚/.test(prefix)) return "evening";
    if (/下午|午后/.test(prefix)) return "afternoon";
    if (/中午/.test(prefix)) return "noon";
    if (/凌晨/.test(prefix)) return "dawn";
    if (/早上|早晨|上午|今早|明早/.test(prefix)) return "morning";
    return "";
  }

  function applyPeriod(hour, period) {
    if (period === "evening" || period === "afternoon") {
      if (hour < 12) return hour + 12;
      return hour;
    }
    if (period === "noon" && hour < 11) return hour + 12;
    if ((period === "morning" || period === "dawn") && hour === 12) return 0;
    return hour;
  }

  function extractTime(text) {
    const normalized = text.replace(
      /([零〇一二两三四五六七八九十]{1,3})(?=\s*(?:点|时))/g,
      (match) => {
        const n = cnToNumber(match);
        return n == null ? match : String(n);
      }
    );

    let range = null;
    const colonRange = normalized.match(/(\d{1,2})\s*[:：.]\s*(\d{2})\s*(?:-|–|—|~|～|至|到)\s*(\d{1,2})\s*[:：.]\s*(\d{2})/);
    if (colonRange) {
      const prefix = normalized.slice(Math.max(0, colonRange.index - 7), colonRange.index);
      const period = periodFromPrefix(prefix);
      const startH = applyPeriod(Number(colonRange[1]), period);
      const endH = applyPeriod(Number(colonRange[3]), period);
      range = {
        index: colonRange.index,
        length: colonRange[0].length,
        start: startH * 60 + Number(colonRange[2]),
        end: endH * 60 + Number(colonRange[4]),
        period,
        text: colonRange[0]
      };
    }

    if (!range) {
      const pointRange = normalized.match(/(\d{1,2})\s*点\s*(半|\d{1,2}\s*分?)?\s*(?:-|–|—|~|～|至|到)\s*(\d{1,2})\s*点\s*(半|\d{1,2}\s*分?)?/);
      if (pointRange) {
        const prefix = normalized.slice(Math.max(0, pointRange.index - 7), pointRange.index);
        const period = periodFromPrefix(prefix);
        const startMinute = pointRange[2] === "半" ? 30 : pointRange[2] ? Number(pointRange[2].replace(/\D/g, "")) || 0 : 0;
        const endMinute = pointRange[4] === "半" ? 30 : pointRange[4] ? Number(pointRange[4].replace(/\D/g, "")) || 0 : 0;
        range = {
          index: pointRange.index,
          length: pointRange[0].length,
          start: applyPeriod(Number(pointRange[1]), period) * 60 + startMinute,
          end: applyPeriod(Number(pointRange[3]), period) * 60 + endMinute,
          period,
          text: pointRange[0]
        };
      }
    }

    if (range) {
      if (range.end <= range.start && range.end < 12 * 60 && range.start >= 12 * 60) range.end += 12 * 60;
      if (range.end <= range.start) range.end = range.start + 60;
      return { ...range, isRange: true };
    }

    const colon = normalized.match(/(\d{1,2})\s*[:：.]\s*(\d{2})/);
    if (colon) {
      const prefix = normalized.slice(Math.max(0, colon.index - 7), colon.index);
      const period = periodFromPrefix(prefix);
      const minutes = applyPeriod(Number(colon[1]), period) * 60 + Number(colon[2]);
      return { index: colon.index, length: colon[0].length, start: minutes, end: minutes, period, text: colon[0], isRange: false };
    }

    const point = normalized.match(/(\d{1,2})\s*点\s*(半|\d{1,2}\s*分?)?/);
    if (point) {
      const prefix = normalized.slice(Math.max(0, point.index - 7), point.index);
      const period = periodFromPrefix(prefix);
      const minute = point[2] === "半" ? 30 : point[2] ? Number(point[2].replace(/\D/g, "")) || 0 : 0;
      const minutes = applyPeriod(Number(point[1]), period) * 60 + minute;
      return { index: point.index, length: point[0].length, start: minutes, end: minutes, period, text: point[0], isRange: false };
    }

    return null;
  }

  function extractDate(text, base = new Date()) {
    const today = dateKey(base);
    const info = { key: null, explicit: false, relative: false, weekday: false, period: "" };
    if (/今晚|今天晚上/.test(text)) { info.key = today; info.explicit = true; info.period = "evening"; }
    if (/明晚|明天晚上/.test(text)) { info.key = addDaysKey(today, 1); info.explicit = true; info.period = "evening"; }
    if (/明早|明天早上|明天上午/.test(text)) { info.key = addDaysKey(today, 1); info.explicit = true; info.period = "morning"; }
    if (/今早|今天早上|今天上午/.test(text)) { info.key = today; info.explicit = true; info.period = "morning"; }

    const md = text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]?/);
    if (md) {
      let year = md[1] ? Number(md[1]) : base.getFullYear();
      const month = Number(md[2]);
      const day = Number(md[3]);
      let d = new Date(year, month - 1, day);
      if (d.getMonth() !== month - 1) return info;
      if (!md[1] && d < addDays(startOfDay(base), -31)) {
        year += 1;
        d = new Date(year, month - 1, day);
      }
      info.key = dateKey(d);
      info.explicit = true;
      return info;
    }

    const rel = text.match(/大后天|后天|明天|明日|今天|今日|昨天/);
    if (rel) {
      const offsets = { 大后天: 3, 后天: 2, 明天: 1, 明日: 1, 今天: 0, 今日: 0, 昨天: -1 };
      info.key = addDaysKey(today, offsets[rel[0]]);
      info.explicit = true;
      info.relative = true;
      if (rel[0] === "今晚") info.period = "evening";
      return info;
    }

    const week = text.match(/(下下|下|这|本)?(?:周|星期|礼拜)([一二三四五六日天])/);
    if (week) {
      const prefix = week[1] || "";
      const char = week[2];
      const target = char === "天" || char === "日" ? 7 : "一二三四五六日".indexOf(char) + 1;
      const currentDay = base.getDay() || 7;
      if (prefix === "下下") {
        info.key = addDaysKey(dateKey(startOfWeek(base)), 14 + target - 1);
      } else if (prefix === "下") {
        info.key = addDaysKey(dateKey(startOfWeek(base)), 7 + target - 1);
      } else if (prefix === "这" || prefix === "本") {
        info.key = addDaysKey(dateKey(startOfWeek(base)), target - 1);
      } else {
        const diff = (target + 7 - currentDay) % 7;
        info.key = addDaysKey(today, diff);
      }
      info.explicit = true;
      info.weekday = true;
      return info;
    }

    const daysLater = text.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*天后/);
    if (daysLater) {
      const n = cnToNumber(daysLater[1]);
      if (n != null) {
        info.key = addDaysKey(today, n);
        info.explicit = true;
        info.relative = true;
      }
    }
    return info;
  }

  function extractDuration(text) {
    const oneHalf = text.match(/一个半小时|一个半钟/);
    if (oneHalf) return 90;
    const half = text.match(/半小时/);
    if (half) return 30;
    const hour = text.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|钟头|h|hr|hours?)(?:\s*(\d{1,2})\s*分)?/i);
    if (hour) {
      const h = Number(hour[1]);
      const m = hour[2] ? Number(hour[2]) : 0;
      if (Number.isFinite(h)) return Math.round(h * 60 + m);
    }
    const cnHour = text.match(/([一二两三四五六七八九十]{1,3})\s*(?:个)?\s*小时(?:\s*([一二两三四五六七八九十]{1,3})\s*分)?/);
    if (cnHour) {
      const h = cnToNumber(cnHour[1]) || 0;
      const m = cnHour[2] ? cnToNumber(cnHour[2]) || 0 : 0;
      return h * 60 + m;
    }
    const minutes = text.match(/(\d{1,3})\s*(?:分钟|min)(?![a-z])/i);
    if (minutes) return Number(minutes[1]);
    return null;
  }

  function extractWeekdays(text) {
    const map = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6, "1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5, "7": 6 };
    const days = [];
    const push = (ch) => {
      if (hasOwn(map, ch) && !days.includes(map[ch])) days.push(map[ch]);
    };
    const range = text.match(/(?:周|星期|礼拜)([一二三四五六日天1-7])\s*(?:至|到|-|~|～)\s*(?:周|星期|礼拜)?([一二三四五六日天1-7])/);
    if (range) {
      const start = map[range[1]];
      const end = map[range[2]];
      if (start !== undefined && end !== undefined) {
        let cursor = start;
        for (let i = 0; i < 7; i += 1) {
          push(String(cursor + 1));
          if (cursor === end) break;
          cursor = (cursor + 1) % 7;
        }
        return days;
      }
    }
    const re = /(?:周|星期|礼拜)([一二三四五六日天1-7](?:\s*[、,，和及]?\s*[一二三四五六日天1-7])*)/g;
    let match;
    while ((match = re.exec(text))) {
      for (const ch of match[1]) push(ch);
    }
    return days;
  }

  function weekdayListLabel(days) {
    const names = ["一", "二", "三", "四", "五", "六", "日"];
    return days.map((day) => names[day]).join("、");
  }

  function detectCategory(text) {
    if (/体检|医院|看病|牙科|牙医|跑步|健身|运动|瑜伽|冥想|散步|吃药|复诊|睡眠|早睡/.test(text)) return "health";
    if (/论文|作业|复习|考试|课程|上课|学习|阅读|背单词|导师|实验|调研|初稿|文献|高数|数学|英语|物理|化学|思政|经济|Python|编程|自习/.test(text)) return "study";
    if (/会议|开会|评审|客户|项目|汇报|周报|邮件|方案|需求|面试|同事|老板|工作|复盘|数据|组会|学生会|值班/.test(text)) return "work";
    if (/买|购买|取|快递|缴费|交电费|生日|聚会|朋友|家里|打扫|做饭|预约|理发|银行|旅行|订票|超市/.test(text)) return "life";
    return "other";
  }

  function detectPriority(text) {
    if (/紧急|必须|尽快|马上|立刻|asap|高优|!!|！|重要[:：]/.test(text)) return 1;
    if (/不急|有空|顺便|低优|可选/.test(text)) return 3;
    return 2;
  }

  function defaultEstimate(text, category) {
    if (/会议|开会|评审|面试/.test(text)) return 60;
    if (/回复|邮件|消息|电话/.test(text)) return 25;
    if (/报告|论文|写作|方案|调研|作业|复习|初稿/.test(text)) return 90;
    if (/跑步|健身|运动|瑜伽|散步/.test(text)) return 45;
    if (/买|取|快递|缴费|预约|理发|银行/.test(text)) return 30;
    if (category === "health") return 45;
    if (category === "study") return 60;
    return 45;
  }

  function cleanTitle(segment) {
    let title = String(segment)
      .replace(/每天|每日|每个月|每月/g, " ")
      .replace(/每个?单周|每个?双周/g, " ")
      .replace(/我都要进行|都要进行|我要进行/g, " ")
      .replace(/(大后天|后天|明天|明日|今天|今日|昨天|今晚|明晚|明早|今早)/g, " ")
      .replace(/(?:下下|下|这|本)?(?:周|星期|礼拜)[一二三四五六日天1-7](?:\s*[、,，和及]?\s*[一二三四五六日天1-7])*/g, " ")
      .replace(/(?:(\d{4})年)?\d{1,2}月\d{1,2}[日号]?/g, " ")
      .replace(/\d{1,2}\s*天后/g, " ")
      .replace(/(\d{1,2})\s*[:：.]\s*(\d{2})\s*(?:-|–|—|~|～|至|到)\s*(\d{1,2})\s*[:：.]\s*(\d{2})/g, " ")
      .replace(/([一二两三四五六七八九十]{1,3})\s*点\s*(半|[一二两三四五六七八九十]{1,3}\s*分?)?\s*(?:-|–|—|~|～|至|到)\s*([一二两三四五六七八九十]{1,3})\s*点\s*(半|[一二两三四五六七八九十]{1,3}\s*分?)?/g, " ")
      .replace(/([一二两三四五六七八九十]{1,3})\s*点\s*(半|[一二两三四五六七八九十]{1,3}\s*分?)?/g, " ")
      .replace(/(\d{1,2})\s*点\s*(半|\d{1,2}\s*分?)?\s*(?:-|–|—|~|～|至|到)\s*(\d{1,2})\s*点\s*(半|\d{1,2}\s*分?)?/g, " ")
      .replace(/(\d{1,2})\s*[:：.]\s*(\d{2})/g, " ")
      .replace(/(\d{1,2})\s*点\s*(半|\d{1,2}\s*分?)?/g, " ")
      .replace(/(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|钟头|h|hr|hours?)(?:\s*(\d{1,2})\s*分)?/gi, " ")
      .replace(/([一二两三四五六七八九十]{1,3})\s*(?:个)?\s*小时(?:\s*([一二两三四五六七八九十]{1,3})\s*分)?/g, " ")
      .replace(/(\d{1,3})\s*(?:分钟|min)(?![a-z])/gi, " ")
      .replace(/一个半小时|一个半钟|半小时/g, " ")
      .replace(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间)/g, " ")
      .replace(/^\s*从\s*/, "")
      .replace(/\s*从\s*$/, "")
      .replace(/^\s+/, "")
      .replace(/^每\s*/, "")
      .replace(/(紧急|尽快|马上|立刻|asap|高优|不急|有空|顺便|低优|可选)/gi, " ")
      .replace(/^重要\s*[:：]\s*/, "")
      .replace(/^(记得|帮我|请|麻烦|安排|提醒我|我要|我需要|需要|要|得|把)\s*/, "")
      .replace(/^(之前|以前|截止|ddl|due|前)\s*/i, " ")
      .replace(/[，,。；;：:\s、]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!title) title = "未命名事项";
    return title.slice(0, 80);
  }

  function splitSegments(text) {
    const rough = String(text).split(/\n+|；|;|。/).map((s) => s.trim()).filter(Boolean);
    const pieces = [];
    rough.forEach((chunk) => {
      const parts = chunk.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
      let buffer = "";
      parts.forEach((part) => {
        const durationOnly = /^(大约|大概|约)?\s*(\d+(\.\d+)?\s*(个)?(小时|分钟|分|h)|半小时|一个半小时|一个半钟)(左右)?$/i.test(part);
        const continuation = /^(地点|地址|在|于|备注|带上|记得带|会议室|线上|电话|联系人)/.test(part);
        if (buffer && (durationOnly || continuation)) {
          buffer += ` ${part}`;
        } else {
          if (buffer) pieces.push(buffer);
          buffer = part;
        }
      });
      if (buffer) pieces.push(buffer);
    });
    return pieces.slice(0, 8);
  }

  function recurrenceOccurrences(segment, now, startMinutes, estimate) {
    const weekdays = extractWeekdays(segment);
    const hasParity = /单周|双周/.test(segment);
    const everyWeek = /每周|每星期|每个?礼拜/.test(segment);
    if (!weekdays.length || startMinutes === null || (!hasParity && !everyWeek)) return null;

    const parity = /单周/.test(segment) ? "odd" : (/双周/.test(segment) ? "even" : "all");
    const startSetting = state.settings.semesterStart || "2026-08-31";
    const semesterStart = keyDate(startSetting) || keyDate("2026-08-31");
    const semesterWeeks = clamp(Number(state.settings.semesterWeeks) || 19, 1, 30);
    const diffDays = Math.floor((startOfDay(now).getTime() - startOfDay(semesterStart).getTime()) / 86400000);
    const currentWeek = Math.max(1, Math.floor(diffDays / 7) + 1);
    const occurrences = [];

    for (let week = currentWeek; week <= semesterWeeks; week += 1) {
      if (parity === "odd" && week % 2 === 0) continue;
      if (parity === "even" && week % 2 !== 0) continue;
      weekdays.forEach((weekdayIndex) => {
        const day = addDays(semesterStart, (week - 1) * 7 + weekdayIndex);
        const date = dateKey(day);
        const start = combineDateTime(date, startMinutes);
        const end = combineDateTime(date, startMinutes + estimate);
        if (new Date(start) <= new Date(now.getTime() + 60000)) return;
        occurrences.push({ week, date, start, end, weekday: weekdayIndex });
      });
    }
    occurrences.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return occurrences;
  }

  function parseSegment(segment, base = new Date()) {
    const now = new Date(base);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const today = dateKey(now);
    const dateInfo = extractDate(segment, now);
    const timeInfo = extractTime(segment);
    const duration = extractDuration(segment);
    const hasBefore = /(之前|以前|截止|ddl|due|前(?=交|完成|提交|发|上传|做|写|给|必须|得))/.test(segment);
    const category = detectCategory(segment);
    const priority = detectPriority(segment);
    const repeat = /单周/.test(segment) ? "单周" : (/双周/.test(segment) ? "双周" : (/每周|每星期|每个?礼拜/.test(segment) ? "每周" : (/每天|每日/.test(segment) ? "每天" : "")));

    let targetDate = dateInfo.key || today;
    let explicitDate = Boolean(dateInfo.key);
    let startMinutes = timeInfo ? timeInfo.start : null;
    let endMinutes = timeInfo ? timeInfo.end : null;

    if (timeInfo && !explicitDate && startMinutes < nowMinutes - 15) {
      targetDate = addDaysKey(today, 1);
    }
    if (timeInfo && dateInfo.weekday && dateInfo.key === today && startMinutes !== null && startMinutes < nowMinutes) {
      targetDate = addDaysKey(today, 7);
    }

    const fixed = Boolean(timeInfo && !hasBefore);
    const estimateFromRange = timeInfo && timeInfo.isRange ? Math.max(15, timeInfo.end - timeInfo.start) : null;
    const estimate = clamp(
      estimateFromRange || duration || defaultEstimate(segment, category) || state.settings.defaultDuration || 45,
      15,
      240
    );

    let deadline = null;
    if (hasBefore && timeInfo && targetDate) {
      deadline = combineDateTime(targetDate, startMinutes);
    } else if (hasBefore && explicitDate) {
      deadline = combineDateTime(targetDate, 18 * 60);
    } else if (!timeInfo && explicitDate) {
      deadline = combineDateTime(targetDate, 18 * 60);
    }

    let availableFrom = null;
    if (!fixed && explicitDate && !hasBefore && targetDate > today) {
      availableFrom = targetDate;
    }

    let start = null;
    let end = null;
    let repeatOccurrences = null;
    let repeatLabel = "";
    if (fixed && timeInfo && startMinutes !== null) {
      start = combineDateTime(targetDate, startMinutes);
      end = combineDateTime(targetDate, startMinutes + estimate);
      const occurrences = recurrenceOccurrences(segment, now, startMinutes, estimate);
      if (occurrences && occurrences.length) {
        repeatOccurrences = occurrences;
        targetDate = occurrences[0].date;
        start = occurrences[0].start;
        end = occurrences[0].end;
        const repeatDays = extractWeekdays(segment);
        repeatLabel = `${repeat || "每周"}${repeatDays.length > 1 ? ` 周${weekdayListLabel(repeatDays)}` : ""} · ${occurrences.length} 次`;
      }
    }

    return {
      title: cleanTitle(segment),
      notes: segment,
      category,
      priority,
      estimate,
      fixed,
      dateKey: targetDate,
      start,
      end,
      deadline,
      availableFrom,
      reminderLead: null,
      repeat,
      repeatOccurrences,
      repeatLabel,
      source: segment
    };
  }

  function isTimeOnlySegment(segment) {
    let rest = String(segment)
      .replace(/(\d{1,2})\s*[:：.]\s*(\d{2})\s*(?:-|–|—|~|～|至|到)\s*(\d{1,2})\s*[:：.]\s*(\d{2})/g, " ")
      .replace(/(?:[一二两三四五六七八九十]{1,3}|\d{1,2})\s*点\s*(?:半|[一二两三四五六七八九十\d]{1,3}\s*分?)?\s*(?:-|–|—|~|～|至|到)\s*(?:[一二两三四五六七八九十]{1,3}|\d{1,2})\s*点\s*(?:半|[一二两三四五六七八九十\d]{1,3}\s*分?)?/g, " ")
      .replace(/(\d{1,2})\s*[:：.]\s*(\d{2})/g, " ")
      .replace(/(?:[一二两三四五六七八九十]{1,3}|\d{1,2})\s*点\s*(?:半|[一二两三四五六七八九十\d]{1,3}\s*分?)?/g, " ")
      .replace(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间|从|到|至|开始|结束|时间|左右|之间)/g, " ")
      .replace(/[，,。；;、\s]/g, "");
    return !rest;
  }

  function mergeTimeOnlySegments(segments) {
    const merged = [];
    segments.forEach((segment) => {
      if (merged.length && isTimeOnlySegment(segment)) {
        merged[merged.length - 1] = `${merged[merged.length - 1]}，${segment}`;
      } else {
        merged.push(segment);
      }
    });
    return merged;
  }

  function parseNaturalInput(text, base = new Date()) {
    const drafts = mergeTimeOnlySegments(splitSegments(text)).map((segment) => parseSegment(segment, base)).filter((draft) => draft.title);
    const named = drafts.filter((draft) => draft.title !== "未命名事项");
    if (named.length && drafts.length > 1) {
      const fallback = named[named.length - 1];
      drafts.forEach((draft) => {
        if (draft.title === "未命名事项") {
          draft.title = fallback.title;
          draft.category = detectCategory(fallback.title);
          draft.notes = `${draft.notes} · ${fallback.title}`;
        }
      });
    }
    return drafts;
  }

  // ---------------------------------------------------------------------------
  // optional DeepSeek AI parser (browser-side, key stays in this browser)

  function aiKey() {
    return (localStorage.getItem(AI_KEY_STORAGE) || "").trim();
  }

  function aiModel() {
    return localStorage.getItem(AI_MODEL_STORAGE) || "deepseek-flash";
  }

  function aiEnabled() {
    return aiKey() && localStorage.getItem(AI_ENABLED_STORAGE) !== "false";
  }

  function updateAITag() {
    const tag = $("#aiTag");
    const label = $("#captureSubmitLabel");
    const manage = captureMode === "manage";
    if (tag) tag.innerHTML = `<i></i>${manage ? "AI 日程管理" : (aiEnabled() ? "AI 增强解析" : "自然语言解析")}`;
    if (label) label.textContent = manage ? "执行修改" : (aiEnabled() ? "AI 帮我安排" : "帮我安排");
  }

  function setCaptureMode(mode) {
    captureMode = mode === "manage" ? "manage" : "add";
    $$("#captureMode button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.captureMode === captureMode);
    });
    const input = $("#captureInput");
    if (input) {
      input.placeholder = captureMode === "manage"
        ? "例：把 11 月 18 日的学生会值班改到周四 10 点；或删除明天下午的会议"
        : "例：明天下午 3 点和导师开会，周五前交实验报告";
      input.focus();
    }
    const examples = $(".capture-examples");
    if (examples) examples.hidden = captureMode === "manage";
    parsedDrafts = [];
    parsedActions = [];
    managementReply = "";
    $("#parsePreview").hidden = true;
    updateAITag();
  }

  function setVoiceState(active) {
    const button = $("#voiceBtn");
    if (!button) return;
    button.classList.toggle("is-listening", active);
    button.setAttribute("aria-label", active ? "停止语音输入" : "语音输入");
  }

  function toggleVoiceInput() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      showToast("这个浏览器不支持语音识别", "请用 Chrome、Edge 或较新的 Safari；也可以直接打字。", "warn", 9000);
      return;
    }
    if (voiceRecognition) {
      try { voiceRecognition.stop(); } catch { /* ignore */ }
      voiceRecognition = null;
      setVoiceState(false);
      return;
    }
    const recognition = new Recognition();
    voiceRecognition = recognition;
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setVoiceState(true);
    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      const input = $("#captureInput");
      if (input) input.value = transcript.trim();
    };
    recognition.onerror = (event) => {
      setVoiceState(false);
      voiceRecognition = null;
      const reason = event.error === "not-allowed"
        ? "浏览器没有麦克风权限，请在地址栏允许麦克风。"
        : `语音识别出错：${event.error || "unknown"}`;
      showToast("语音输入失败", reason, "warn", 8000);
    };
    recognition.onend = () => {
      setVoiceState(false);
      voiceRecognition = null;
      $("#captureInput")?.focus();
    };
    try {
      recognition.start();
      showToast("正在听…", "说完后可以检查文字，再点「AI 帮我安排」。", "default", 4000);
    } catch (error) {
      setVoiceState(false);
      voiceRecognition = null;
      showToast("无法启动语音输入", String(error.message || error), "warn");
    }
  }

  function renderAISettings() {
    const keyInput = $("#aiApiKey");
    const modelInput = $("#aiModel");
    const enabledInput = $("#aiEnabled");
    const status = $("#aiStatus");
    if (!keyInput || !modelInput || !enabledInput || !status) return;
    keyInput.value = "";
    keyInput.placeholder = aiKey() ? "已保存（留空保持不变）" : "sk-...";
    modelInput.value = aiModel();
    enabledInput.checked = aiEnabled();
    const on = aiEnabled();
    status.textContent = aiKey() ? (on ? "已启用" : "已保存，未启用") : "未配置";
    status.classList.toggle("is-on", Boolean(on));
    updateAITag();
  }

  function expandAIOccurrences(firstDate, startTime, endTime, repeat) {
    if (!/^(odd|even|weekly)$/.test(repeat || "")) return [];
    const startMinutes = minutesFromTime(startTime, 9 * 60);
    const endMinutes = minutesFromTime(endTime, startMinutes + 45);
    const estimate = Math.max(15, endMinutes - startMinutes);
    const semesterStart = keyDate(state.settings.semesterStart || "2026-08-31") || keyDate("2026-08-31");
    const semesterWeeks = clamp(Number(state.settings.semesterWeeks) || 19, 1, 30);
    const first = keyDate(firstDate);
    if (!first) return [];
    const firstWeek = Math.max(1, Math.floor((startOfDay(first).getTime() - startOfDay(semesterStart).getTime()) / (7 * 86400000)) + 1);
    const weekdayIndex = (first.getDay() + 6) % 7;
    const occurrences = [];
    for (let week = firstWeek; week <= semesterWeeks; week += 1) {
      if (repeat === "odd" && week % 2 === 0) continue;
      if (repeat === "even" && week % 2 !== 0) continue;
      const day = addDays(semesterStart, (week - 1) * 7 + weekdayIndex);
      const date = dateKey(day);
      if (date < firstDate) continue;
      const start = combineDateTime(date, startMinutes);
      if (new Date(start) <= new Date(Date.now() + 60000)) continue;
      occurrences.push({ week, date, start, end: combineDateTime(date, startMinutes + estimate) });
    }
    return occurrences;
  }

  function normalizeAIDraft(raw, sourceText) {
    if (!raw || typeof raw !== "object" || !raw.title) return null;
    const category = CATEGORY_LABELS[raw.category] ? raw.category : detectCategory(`${raw.title} ${raw.notes || ""}`);
    const priority = [1, 2, 3].includes(Number(raw.priority)) ? Number(raw.priority) : 2;
    const repeat = ["odd", "even", "weekly"].includes(raw.repeat) ? raw.repeat : "";
    const rawDate = String(raw.date || "").replace(/\//g, "-");
    const directStart = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw.start || "") ? String(raw.start).slice(0, 16) : null;
    const directEnd = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw.end || "") ? String(raw.end).slice(0, 16) : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : (directStart ? directStart.slice(0, 10) : null);
    const startTime = /^\d{1,2}:\d{2}$/.test(raw.startTime || "")
      ? raw.startTime
      : (directStart ? directStart.slice(11, 16) : null);
    const endTime = /^\d{1,2}:\d{2}$/.test(raw.endTime || "")
      ? raw.endTime
      : (directEnd ? directEnd.slice(11, 16) : null);
    const deadlineRaw = String(raw.deadline || "").replace(" ", "T");
    const hasDeadline = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(deadlineRaw);
    // If the model returned an explicit start time, honour it instead of
    // letting autoPlan move the item to an arbitrary "free slot".
    const fixed = Boolean(date && startTime && (raw.fixed === true || !hasDeadline));
    const rangeMinutes = fixed && endTime
      ? minutesFromTime(endTime) - minutesFromTime(startTime)
      : null;
    let estimate = clamp(
      rangeMinutes && rangeMinutes >= 15
        ? rangeMinutes
        : (Number(raw.estimate) || 45),
      15,
      240
    );
    let start = fixed ? `${date}T${startTime}` : null;
    let end = fixed
      ? (endTime ? `${date}T${endTime}` : combineDateTime(date, minutesFromTime(startTime) + estimate))
      : null;
    let repeatOccurrences = null;
    let repeatLabel = "";
    if (fixed && repeat) {
      const occurrences = expandAIOccurrences(date, startTime, endTime || timeFromMinutes(minutesFromTime(startTime) + estimate), repeat);
      if (occurrences.length) {
        repeatOccurrences = occurrences;
        start = occurrences[0].start;
        end = occurrences[0].end;
        repeatLabel = `${repeat === "odd" ? "单周" : (repeat === "even" ? "双周" : "每周")} · ${occurrences.length} 次`;
      }
    }
    const deadline = !fixed && hasDeadline
      ? deadlineRaw.slice(0, 16)
      : null;
    return {
      title: String(raw.title).trim().slice(0, 80),
      notes: String(raw.notes || sourceText || "").slice(0, 1000),
      category,
      priority,
      estimate,
      fixed,
      dateKey: repeatOccurrences ? repeatOccurrences[0].date : (date || todayKey()),
      start,
      end,
      deadline,
      availableFrom: null,
      reminderLead: null,
      repeat: repeat === "odd" ? "单周" : (repeat === "even" ? "双周" : (repeat === "weekly" ? "每周" : "")),
      repeatOccurrences,
      repeatLabel,
      source: sourceText
    };
  }

  function extractAIJson(content) {
    const text = String(content || "").trim();
    try { return JSON.parse(text); } catch { /* continue */ }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch { /* continue */ }
    }
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try { return JSON.parse(text.slice(first, last + 1)); } catch { /* continue */ }
    }
    throw new Error("AI 返回的不是有效 JSON");
  }

  async function callDeepSeekJson(system, user) {
    const key = aiKey();
    if (!key) throw new Error("没有配置 DeepSeek API Key");
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model: aiModel(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.1,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        stream: false
      })
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json())?.error?.message || ""; } catch { /* ignore */ }
      throw new Error(detail || `AI 接口返回 ${response.status}`);
    }
    const data = await response.json();
    return extractAIJson(data?.choices?.[0]?.message?.content);
  }

  async function parseWithAI(text) {
    const now = new Date();
    const semesterStart = state.settings.semesterStart || "2026-08-31";
    const calendar = Array.from({ length: 21 }, (_, i) => {
      const key = addDaysKey(todayKey(), i);
      return `${key} ${weekdayLabel(key)}`;
    }).join("；");
    const system = `你是中文日程解析器。把用户的话解析成结构化任务，只输出 JSON，不要 Markdown。
当前本地时间：${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}（UTC+8）
学期第一周周一：${semesterStart}
学期总周数：${state.settings.semesterWeeks || 19}
未来 21 天日历：${calendar}
输出格式：{"tasks":[{"title":"简洁中文标题","notes":"地点/备注","category":"work|study|life|health|other","priority":1|2|3,"estimate":分钟数,"fixed":true|false,"date":"YYYY-MM-DD"|null,"startTime":"HH:mm"|null,"endTime":"HH:mm"|null,"deadline":"YYYY-MM-DDTHH:mm"|null,"repeat":"none|weekly|odd|even"}]}
规则：
1. 一句话里的地点、备注、同义补充并入同一件事，不要拆成独立任务；只有明确不同的行动才拆成多条。
2. 有明确开始时间（如“14:10-15:40”“下午3点”）时 fixed=true，填 date/startTime/endTime；没有结束时间就按合理用时估算。
3. “周五前交”“截止到……”这类是截止时间：fixed=false，填 deadline，estimate 为预计用时。
4. 只有日期没有具体时间：fixed=false，deadline 填该日 18:00，除非用户明确说是会议/约见。
5. “每个单周周一” repeat=odd；“每个双周周三” repeat=even；“每周X” repeat=weekly；date 填从现在开始的第一次发生日期，不要填过去日期。
6. “明天/后天/下周三/这周五”等相对日期，必须按上面的 21 天日历换算，并核对星期几，不要算错一天。
7. 普通一次性日程 repeat=none。
8. 时间用 24 小时制；不要编造用户没说的信息。
9. 标题保留课程名、人名、地点等关键信息，但不要把时间/时长写进标题。
示例：输入“每个单周周一14:10-15:40，每个双周周三10:00-11:40我都要进行学生会值班”，应输出两个任务，标题都是“学生会值班”，分别 repeat=odd 和 repeat=even，date 分别是下一次单周周一和下一次双周周三，fixed=true。`;
    const payload = await callDeepSeekJson(system, text);
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const drafts = tasks.map((task) => normalizeAIDraft(task, text)).filter(Boolean);
    if (!drafts.length) throw new Error("AI 没有解析出任务");
    return drafts;
  }

  function aiTaskContext() {
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 86400000);
    const to = new Date(now.getTime() + 90 * 86400000);
    return state.tasks
      .filter((task) => {
        const anchor = parseDateTime(task.start) || parseDateTime(task.deadline);
        return !task.done && (!anchor || (anchor >= from && anchor <= to));
      })
      .sort((a, b) => String(a.start || a.deadline || "").localeCompare(String(b.start || b.deadline || "")))
      .slice(0, 120)
      .map((task) => ({
        id: task.id,
        title: task.title,
        start: task.start,
        end: task.end,
        deadline: task.deadline,
        fixed: task.fixed,
        category: task.category,
        estimate: task.estimate,
        notes: task.notes
      }));
  }

  function normalizeAIChanges(changes, task) {
    const source = changes && typeof changes === "object" ? changes : {};
    const out = {};
    if (typeof source.title === "string" && source.title.trim()) out.title = source.title.trim().slice(0, 80);
    if (typeof source.notes === "string") out.notes = source.notes.slice(0, 1000);
    if (CATEGORY_LABELS[source.category]) out.category = source.category;
    if ([1, 2, 3].includes(Number(source.priority))) out.priority = Number(source.priority);
    if (source.estimate !== undefined && Number(source.estimate) >= 15) out.estimate = clamp(Number(source.estimate), 15, 240);

    const rawDate = String(source.date || "").replace(/\//g, "-");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
    const startTime = /^\d{1,2}:\d{2}$/.test(source.startTime || "") ? source.startTime : null;
    const endTime = /^\d{1,2}:\d{2}$/.test(source.endTime || "") ? source.endTime : null;
    let start = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(source.start || "") ? String(source.start).slice(0, 16) : null;
    let end = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(source.end || "") ? String(source.end).slice(0, 16) : null;
    if (!start && date && startTime) start = `${date}T${startTime}`;
    if (!end && date && endTime) end = `${date}T${endTime}`;
    if (!end && start) {
      const estimate = out.estimate || Number(task.estimate) || 45;
      end = combineDateTime(dateKey(parseDateTime(start)), minutesFromTime(start.slice(11, 16)) + estimate);
    }
    if (start) {
      out.start = start;
      out.end = end;
      out.fixed = true;
      out.deadline = null;
    } else if (source.fixed === false) {
      out.fixed = false;
      out.start = null;
      out.end = null;
    }
    const deadlineRaw = String(source.deadline || "").replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(deadlineRaw)) {
      out.deadline = deadlineRaw.slice(0, 16);
      out.fixed = false;
      out.start = null;
      out.end = null;
    }
    return out;
  }

  async function parseManagementWithAI(text) {
    const now = new Date();
    const tasks = aiTaskContext();
    const system = `你是日序的日程管理助手。用户会要求修改或删除已有日程。你只能操作下面给出的任务 id，不能编造 id，也不能新增任务。
当前本地时间：${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}（UTC+8）
只输出 JSON，不要 Markdown，格式：
{"reply":"给用户的一句中文说明","actions":[{"type":"delete","taskId":"..."},{"type":"update","taskId":"...","changes":{"title":"新标题","start":"YYYY-MM-DDTHH:mm","end":"YYYY-MM-DDTHH:mm","deadline":"YYYY-MM-DDTHH:mm","estimate":45,"category":"work","priority":2,"notes":"..."}}]}
规则：
1. 先根据标题、日期、时间匹配任务；匹配不确定时 actions 为空，reply 问清楚。
2. 用户说“删除/取消/去掉” -> delete；说“改到/换成/提前/推迟/修改” -> update。
3. 改时间必须输出完整本地时间 start/end；如果只改标题或分类，只输出对应字段。
4. 用户说“所有/每次/全部单周”时，把匹配到的每个任务 id 都输出一条 action。
5. 不要修改无关任务；不要返回 add。
6. 当前日程：${JSON.stringify(tasks)}`;
    const payload = await callDeepSeekJson(system, text);
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const normalized = [];
    actions.slice(0, 30).forEach((action) => {
      const task = state.tasks.find((item) => item.id === action.taskId);
      if (!task) return;
      if (action.type === "delete") {
        normalized.push({ type: "delete", taskId: task.id, before: task });
      } else if (action.type === "update") {
        const changes = normalizeAIChanges(action.changes, task);
        if (Object.keys(changes).length) normalized.push({ type: "update", taskId: task.id, before: task, changes });
      }
    });
    return { reply: String(payload.reply || "").trim(), actions: normalized };
  }

  function setCaptureBusy(busy) {
    const button = $("#captureSubmit");
    const label = $("#captureSubmitLabel");
    if (!button || !label) return;
    button.disabled = busy;
    if (busy) {
      button.dataset.label = label.textContent;
      label.textContent = captureMode === "manage" ? "AI 正在查找…" : "AI 正在理解…";
    } else if (button.dataset.label) {
      label.textContent = button.dataset.label;
      delete button.dataset.label;
    }
  }

  // ---------------------------------------------------------------------------
  // reminders / notifications

  function isQuietNow(now = new Date()) {
    const settings = state.settings;
    if (!settings.quietEnabled) return false;
    const start = minutesFromTime(settings.quietStart, 22 * 60);
    const end = minutesFromTime(settings.quietEnd, 8 * 60);
    const current = now.getHours() * 60 + now.getMinutes();
    if (start <= end) return current >= start && current < end;
    return current >= start || current < end;
  }

  function reminderLeadFor(task) {
    return task.reminderLead === null || task.reminderLead === undefined
      ? Number(state.settings.defaultLead) || 0
      : Number(task.reminderLead);
  }

  function buildReminders(limit = 40) {
    const now = new Date();
    const entries = [];
    state.tasks.forEach((task) => {
      if (task.done) return;
      const start = parseDateTime(task.start);
      const end = parseDateTime(task.end) || (start ? new Date(start.getTime() + (task.estimate || 45) * 60000) : null);
      if (start && end && start > now) {
        const lead = reminderLeadFor(task);
        const at = new Date(start.getTime() - lead * 60000);
        entries.push({
          id: `${task.id}-start-${task.start}`,
          task,
          kind: "start",
          at,
          lead,
          when: start,
          label: lead === 0 ? "准时提醒" : `提前 ${lead >= 60 ? `${Math.round(lead / 60)} 小时` : `${lead} 分钟`}`
        });
      }
      const deadline = parseDateTime(task.deadline);
      if (deadline && deadline > now && state.settings.deadlineReminder) {
        const lead = clamp(Number(state.settings.deadlineLead) || 0, 0, 2880);
        entries.push({
          id: `${task.id}-deadline-${task.deadline}`,
          task,
          kind: "deadline",
          at: new Date(deadline.getTime() - lead * 60000),
          lead,
          when: deadline,
          label: lead === 0 ? "截止提醒" : `截止前 ${lead >= 60 ? `${Math.round(lead / 60)} 小时` : `${lead} 分钟`}`
        });
      }
    });
    return entries
      .sort((a, b) => a.when - b.when)
      .slice(0, limit);
  }

  function notificationSupported() {
    return typeof window !== "undefined" && "Notification" in window;
  }

  async function requestNotificationPermission() {
    if (!notificationSupported()) {
      showToast("浏览器不支持系统通知", "可以启动本地助理，使用 Windows 通知。", "warn");
      return false;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        showToast("浏览器提醒已开启", "页面在后台时也会尽量提醒你。", "success");
        return true;
      }
      showToast("没有获得通知权限", "可以在浏览器地址栏的站点设置里重新允许。", "warn");
      return false;
    } catch {
      return false;
    }
  }

  async function showBrowserNotification(title, body, taskId) {
    if (!notificationSupported() || Notification.permission !== "granted") return false;
    const options = {
      body,
      icon: "assets/icon-192.png",
      badge: "assets/icon-192.png",
      tag: `dayflow-${taskId || Date.now()}`,
      data: { taskId },
      silent: !state.settings.sound
    };
    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(title, options);
        return true;
      }
      new Notification(title, options);
      return true;
    } catch {
      return false;
    }
  }

  function playChime() {
    if (!state.settings.sound) return;
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      if (!audioContext) audioContext = new AudioCtor();
      if (audioContext.state === "suspended") audioContext.resume();
      const now = audioContext.currentTime;
      [523.25, 659.25].forEach((freq, index) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + index * 0.11);
        gain.gain.exponentialRampToValueAtTime(0.055, now + index * 0.11 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.11 + 0.32);
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.start(now + index * 0.11);
        osc.stop(now + index * 0.11 + 0.34);
      });
    } catch {
      /* audio is a nice-to-have; never break a reminder for it */
    }
  }

  function localEvent(title, body, kind, taskId) {
    const events = Array.isArray(state.meta.events) ? state.meta.events : [];
    const id = Math.max(0, ...events.map((e) => Number(e.id) || 0)) + 1;
    state.meta.events = events.concat({
      id,
      at: new Date().toISOString(),
      title,
      body,
      kind,
      taskId,
      channels: { browser: notificationSupported() && Notification.permission === "granted" }
    }).slice(-100);
  }

  function checkLocalReminders() {
    if (serverMode || !state || isQuietNow()) return;
    const now = new Date();
    const notified = new Set(state.meta.notified || []);
    let changed = false;
    state.tasks.forEach((task) => {
      if (task.done) return;
      const start = parseDateTime(task.start);
      if (start) {
        const lead = reminderLeadFor(task);
        const at = new Date(start.getTime() - lead * 60000);
        const key = `start|${task.id}|${task.start}|${lead}`;
        if (now >= at && now <= new Date(start.getTime() + 5 * 60000) && !notified.has(key)) {
          notified.add(key);
          changed = true;
          localEvent("该准备了", `${timeFromMinutes(start.getHours() * 60 + start.getMinutes())} · ${task.title}`, "start", task.id);
          showToast(`提醒 · ${task.title}`, `${timeFromMinutes(start.getHours() * 60 + start.getMinutes())} 开始，提前 ${lead} 分钟提醒你。`, "warn", 11000);
          showBrowserNotification("日序提醒", `${timeFromMinutes(start.getHours() * 60 + start.getMinutes())} · ${task.title}`, task.id);
          playChime();
        }
      }
      const deadline = parseDateTime(task.deadline);
      if (deadline && state.settings.deadlineReminder) {
        const lead = clamp(Number(state.settings.deadlineLead) || 0, 0, 2880);
        const at = new Date(deadline.getTime() - lead * 60000);
        const key = `deadline|${task.id}|${task.deadline}|${lead}`;
        if (now >= at && now <= deadline && !notified.has(key)) {
          notified.add(key);
          changed = true;
          localEvent("截止提醒", `${task.title} · 还有不到 ${Math.max(1, Math.round((deadline - now) / 60000))} 分钟`, "deadline", task.id);
          showToast(`截止提醒 · ${task.title}`, "截止时间快到了，记得留出提交和检查的时间。", "warn", 11000);
          showBrowserNotification("日序 · 截止提醒", `${task.title} 即将截止`, task.id);
          playChime();
        }
      }
    });
    if (changed) {
      const merged = Array.from(notified).slice(-500);
      state.meta.notified = merged;
      saveState();
      if (currentView === "reminders") renderReminders();
      renderBell();
    }
  }

  async function pollServerEvents(initial = false) {
    if (!serverMode) return;
    try {
      const data = initial
        ? await api("/api/events?since=0")
        : await api(`/api/events?since=${eventCursor}`);
      const incoming = Array.isArray(data.events) ? data.events : [];
      if (initial) {
        serverEvents = incoming;
        eventCursor = Math.max(0, ...incoming.map((e) => Number(e.id) || 0));
        renderBell();
        if (currentView === "reminders") renderReminders();
        return;
      }
      if (incoming.length) {
        incoming.forEach((event) => {
          showToast(`提醒 · ${event.title || "日程提醒"}`, event.body || "", event.kind === "deadline" ? "warn" : "default", 10000);
        });
        const existing = new Set(serverEvents.map((e) => e.id));
        incoming.forEach((event) => {
          if (!existing.has(event.id)) serverEvents.push(event);
        });
        serverEvents = serverEvents.slice(-100);
        eventCursor = Math.max(eventCursor, ...incoming.map((e) => Number(e.id) || 0));
        renderBell();
        if (currentView === "reminders") renderReminders();
      }
    } catch {
      // The local UI keeps working if the background service was stopped.
    }
  }

  // ---------------------------------------------------------------------------
  // view rendering helpers

  function categoryLabel(category) {
    return CATEGORY_LABELS[category] || "其他";
  }

  function tasksForDay(key) {
    return state.tasks
      .filter((task) => {
        const start = parseDateTime(task.start);
        return start && dateKey(start) === key;
      })
      .sort((a, b) => {
        const sa = parseDateTime(a.start);
        const sb = parseDateTime(b.start);
        return (sa?.getTime() || 0) - (sb?.getTime() || 0);
      });
  }

  function cleanTimeRange(start, end) {
    const s = parseDateTime(start);
    const e = parseDateTime(end);
    if (!s) return "";
    if (!e) return `${pad2(s.getHours())}:${pad2(s.getMinutes())}`;
    return `${pad2(s.getHours())}:${pad2(s.getMinutes())}–${pad2(e.getHours())}:${pad2(e.getMinutes())}`;
  }

  function scheduleText(task) {
    if (!task.start) return "";
    const start = parseDateTime(task.start);
    if (!start) return "";
    const key = dateKey(start);
    if (key === todayKey()) return `今天 ${cleanTimeRange(task.start, task.end)}`;
    if (key === addDaysKey(todayKey(), 1)) return `明天 ${cleanTimeRange(task.start, task.end)}`;
    return `${weekdayLabel(key)} ${cleanTimeRange(task.start, task.end)}`;
  }

  function deadlineText(task) {
    const deadline = parseDateTime(task.deadline);
    if (!deadline) return "";
    const key = dateKey(deadline);
    const time = `${pad2(deadline.getHours())}:${pad2(deadline.getMinutes())}`;
    return `截止 ${dayLabel(key)} ${time}`;
  }

  function minutesForTask(task) {
    const start = parseDateTime(task.start);
    const end = parseDateTime(task.end);
    if (start && end) return Math.max(5, Math.round((end - start) / 60000));
    return task.estimate || 45;
  }

  function weekDays() {
    return Array.from({ length: 7 }, (_, i) => addDaysKey(weekStartKey, i));
  }

  // ---------------------------------------------------------------------------
  // render: common / sidebar / topbar / bell

  function renderCommon() {
    const today = todayKey();
    const openTasks = state.tasks.filter((task) => !task.done && !task.course);
    const todayItems = state.tasks.filter((task) => {
      if (task.done) return false;
      const start = parseDateTime(task.start);
      if (start && dateKey(start) === today) return true;
      const deadline = parseDateTime(task.deadline);
      return deadline && dateKey(deadline) === today;
    });
    $("#navTodayCount").textContent = todayItems.length || "";
    $("#navTaskCount").textContent = openTasks.length || "";
    $("#userName").textContent = state.settings.userName || "朋友";
    $("#userAvatar").textContent = (state.settings.userName || "友").trim().slice(0, 1) || "友";

    const weekStart = dateKey(startOfWeek(new Date()));
    const weekTasks = state.tasks.filter((task) => {
      const start = parseDateTime(task.start);
      return start && dateKey(start) >= weekStart && dateKey(start) <= addDaysKey(weekStart, 6);
    });
    const weekMinutes = weekTasks.reduce((sum, task) => sum + minutesForTask(task), 0);
    $("#sideWeekHours").textContent = weekMinutes >= 60 ? `${(weekMinutes / 60).toFixed(weekMinutes % 60 === 0 ? 0 : 1)}h` : `${weekMinutes}m`;
    const weekTarget = Math.max(60, Number(state.settings.dailyCapacity || 300) * 5);
    $("#sideWeekBar").style.width = `${Math.min(100, Math.round((weekMinutes / weekTarget) * 100))}%`;
    $("#sideWeekHint").textContent = weekMinutes
      ? `${weekTasks.length} 项安排在这周`
      : "还没有安排，添加第一件事吧";

    $("#topDate").textContent = currentView === "plan"
      ? `${shortDate(weekStartKey)} — ${shortDate(addDaysKey(weekStartKey, 6))}`
      : `${dateLabel(dayDate)} ${weekdayLabel(dayDate)}`;
    const sectionNames = { today: "今日", plan: "行程", tasks: "任务箱", reminders: "提醒", settings: "设置" };
    $("#topSection").textContent = sectionNames[currentView] || "今日";

    renderServerStatus();
    renderBell();
    updateAITag();
  }

  function renderServerStatus() {
    const pill = $("#serverPill");
    const title = $("#serverPillTitle");
    const text = $("#serverPillText");
    if (CLOUD_MODE) {
      pill.classList.remove("is-offline");
      title.textContent = "云端同步已连接";
      text.textContent = "手机 / 电脑共用同一个账号";
      return;
    }
    pill.classList.toggle("is-offline", !serverMode);
    if (serverMode) {
      title.textContent = "本地助理运行中";
      text.textContent = `端口 ${location.port || "本机"} · 提醒已接管`;
    } else {
      title.textContent = "浏览器预览模式";
      text.textContent = "启动本地助理，关页也能提醒";
    }
  }

  function renderBell() {
    const entries = buildReminders(20);
    const soon = entries.filter((entry) => entry.when - Date.now() < 24 * 3600 * 1000);
    const badge = $("#bellBadge");
    badge.hidden = soon.length === 0;
    badge.textContent = soon.length > 9 ? "9+" : String(soon.length);
    $("#bellChannel").textContent = CLOUD_MODE
      ? "云端提醒"
      : (serverMode
        ? (["127.0.0.1", "localhost", "::1"].includes(location.hostname) ? "Windows 通知" : "电脑通知 · 手机消息")
        : "浏览器通知");
    const content = $("#bellContent");
    if (!entries.length) {
      content.innerHTML = `<div class="popover-empty">接下来没有提醒。<br>去安排一件小事吧。</div>`;
      return;
    }
    content.innerHTML = entries.slice(0, 3).map((entry) => `
      <div class="popover-item">
        <time>${entry.when.getHours().toString().padStart(2, "0")}:${entry.when.getMinutes().toString().padStart(2, "0")}</time>
        <div><strong>${esc(entry.task.title)}</strong><span>${esc(entry.label)} · ${esc(dayLabel(dateKey(entry.when)))}</span></div>
      </div>
    `).join("");
  }

  // ---------------------------------------------------------------------------
  // render: today

  function renderToday() {
    const key = dayDate;
    const today = todayKey();
    const dayTasks = tasksForDay(key);
    const doneCount = dayTasks.filter((task) => task.done).length;
    const focusMinutes = dayTasks.reduce((sum, task) => sum + minutesForTask(task), 0);
    const fixedCount = dayTasks.filter((task) => task.fixed).length;
    const openDayTasks = dayTasks.filter((task) => !task.done);
    const next = key === today
      ? openDayTasks.find((task) => {
        const end = parseDateTime(task.end) || parseDateTime(task.start);
        return end && end > new Date();
      })
      : openDayTasks[0];

    $("#demoBanner").hidden = !(state.meta.demo && !state.meta.demoBannerDismissed);

    const d = keyDate(key);
    $("#todayEyebrow").textContent = `${WEEKDAYS_EN[d.getDay()]} · ${d.getFullYear()} / ${pad2(d.getMonth() + 1)} / ${pad2(d.getDate())}`;
    const name = state.settings.userName || "朋友";
    if (key === today) {
      if (dayTasks.length === 0) {
        $("#todayTitle").innerHTML = `${greeting()}，<span>今天留白也正好</span>。`;
        $("#todaySub").textContent = "没有排定的事，可以先丢一件小事进来，或者好好休息。";
      } else {
        $("#todayTitle").innerHTML = `${greeting()}，今天有 <span>${dayTasks.length} 件事</span>。`;
        const first = next || dayTasks[0];
        const firstTime = parseDateTime(first?.start);
        $("#todaySub").textContent = `${fixedCount} 项固定日程，${formatDuration(focusMinutes)} 专注时间${firstTime ? `。最近的一项是 ${cleanTimeRange(first.start, first.end)} 的「${first.title}」` : ""}。`;
      }
    } else {
      $("#todayTitle").innerHTML = `${dateLabel(key)}，<span>${weekdayLabel(key)}</span>。`;
      $("#todaySub").textContent = dayTasks.length
        ? `${dayTasks.length} 项安排，${formatDuration(focusMinutes)} 专注时间。`
        : "这一天还没有安排。";
    }

    $("#metricCount").textContent = dayTasks.length;
    $("#metricFocus").textContent = formatDuration(focusMinutes);
    $("#metricDone").textContent = doneCount;

    renderTimeline(dayTasks, key);
    renderNextCard(dayTasks, key);
    renderProgress(dayTasks);
    renderRail(dayTasks);
    renderWeekGlance();

    $("#dayTitle").textContent = key === today ? "今日行程" : `${dateLabel(key)}的行程`;
    $("#backTodayBtn").style.visibility = key === today ? "hidden" : "visible";
    renderCommon();
  }

  function formatDuration(minutes) {
    if (!minutes) return "0h";
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function timelineRange(dayTasks) {
    let start = 7 * 60;
    let end = 22 * 60;
    dayTasks.forEach((task) => {
      const s = parseDateTime(task.start);
      const e = parseDateTime(task.end);
      if (!s) return;
      const sm = s.getHours() * 60 + s.getMinutes();
      const em = e ? e.getHours() * 60 + e.getMinutes() : sm + (task.estimate || 45);
      start = Math.min(start, Math.floor((sm - 30) / 30) * 30);
      end = Math.max(end, Math.ceil((em + 30) / 30) * 30);
    });
    start = clamp(start, 5 * 60, 12 * 60);
    end = clamp(end, 14 * 60, 23 * 60 + 30);
    return { start, end };
  }

  function renderTimeline(dayTasks, key) {
    const range = timelineRange(dayTasks);
    const height = ((range.end - range.start) / 60) * HOUR_HEIGHT_DAY;
    const track = $("#todayTimeline");
    const scroll = $("#timelineScroll");
    const empty = $("#timelineEmpty");

    if (!dayTasks.length) {
      empty.hidden = false;
      scroll.hidden = true;
      $("#dayTitle").textContent = key === todayKey() ? "今日行程" : `${dateLabel(key)}的行程`;
      return;
    }
    empty.hidden = true;
    scroll.hidden = false;

    const lunchStart = minutesFromTime(state.settings.lunchStart, 12 * 60);
    const lunchEnd = minutesFromTime(state.settings.lunchEnd, 13 * 60 + 30);
    const lunchVisible = lunchEnd > range.start && lunchStart < range.end;

    let labels = "";
    let grid = "";
    for (let m = Math.ceil(range.start / 30) * 30; m <= range.end; m += 30) {
      const top = ((m - range.start) / 60) * HOUR_HEIGHT_DAY;
      if (m % 60 === 0) {
        labels += `<span class="timeline-label" style="top:${top}px">${timeFromMinutes(m)}</span>`;
        grid += `<div class="timeline-gridline is-hour" style="top:${top}px"></div>`;
      } else {
        grid += `<div class="timeline-gridline" style="top:${top}px"></div>`;
      }
    }

    let lunch = "";
    if (lunchVisible) {
      const top = ((Math.max(lunchStart, range.start) - range.start) / 60) * HOUR_HEIGHT_DAY;
      const h = ((Math.min(lunchEnd, range.end) - Math.max(lunchStart, range.start)) / 60) * HOUR_HEIGHT_DAY;
      lunch = `<div class="timeline-lunch" style="top:${top}px;height:${h}px"><span class="timeline-lunch-label">午休</span></div>`;
    }

    const blocks = dayTasks.map((task) => {
      const start = parseDateTime(task.start);
      if (!start) return "";
      const startMin = start.getHours() * 60 + start.getMinutes();
      const end = parseDateTime(task.end);
      const endMin = end ? end.getHours() * 60 + end.getMinutes() : startMin + (task.estimate || 45);
      const top = ((startMin - range.start) / 60) * HOUR_HEIGHT_DAY;
      const duration = Math.max(15, endMin - startMin);
      const blockHeight = Math.max((duration / 60) * HOUR_HEIGHT_DAY, 36);
      const now = new Date();
      const isNow = key === todayKey() && now >= start && now < end;
      return `
        <article class="timeline-block tone-${task.category} ${task.fixed ? "is-fixed" : ""} ${task.done ? "is-done" : ""} ${isNow ? "is-now" : ""} ${duration < 60 ? "is-compact" : ""}"
          data-task-id="${esc(task.id)}" style="top:${top}px;height:${blockHeight}px" tabindex="0" role="button" aria-label="${esc(task.title)}">
          <div class="tb-time">${cleanTimeRange(task.start, task.end)}${task.fixed ? `<span class="dot"></span>固定` : ""}</div>
          <div class="tb-title">${esc(task.title)}</div>
          <div class="tb-meta"><span>${categoryLabel(task.category)}</span><span>·</span><span>${task.estimate || 45} 分钟</span>${task.done ? "<span>· 已完成</span>" : ""}</div>
        </article>
      `;
    }).join("");

    let nowLine = "";
    if (key === todayKey()) {
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      if (nowMinutes >= range.start && nowMinutes <= range.end) {
        nowLine = `<div class="timeline-now" style="top:${((nowMinutes - range.start) / 60) * HOUR_HEIGHT_DAY}px"><span>现在</span></div>`;
      }
    }

    track.style.height = `${height}px`;
    track.innerHTML = `
      <div class="timeline-axis">${labels}</div>
      <div class="timeline-track">${grid}${lunch}${blocks}${nowLine}</div>
    `;

    if (key === todayKey()) {
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      requestAnimationFrame(() => {
        scroll.scrollTop = Math.max(0, ((nowMinutes - range.start) / 60) * HOUR_HEIGHT_DAY - 150);
      });
    } else {
      requestAnimationFrame(() => { scroll.scrollTop = 0; });
    }
  }

  function renderNextCard(dayTasks, key) {
    const card = $("#nextCard");
    const open = dayTasks.filter((task) => !task.done);
    const now = new Date();
    let task = null;
    if (key === todayKey()) {
      task = open.find((item) => {
        const end = parseDateTime(item.end) || parseDateTime(item.start);
        return end && end > now;
      }) || null;
    } else {
      task = open[0] || null;
    }

    if (!task) {
      card.classList.add("is-empty");
      $("#nextCountdown").textContent = key === todayKey() ? "今天" : dayLabel(key);
      $("#nextTime").textContent = "--:--";
      $("#nextTitle").textContent = key === todayKey() ? "接下来没有安排了" : "这一天还空着";
      $("#nextMeta").textContent = "留白也是计划的一部分，或者添加一点新的期待。";
      $("#nextAction").href = "#";
      $("#nextAction").dataset.taskId = "";
      return;
    }

    card.classList.remove("is-empty");
    const start = parseDateTime(task.start);
    const end = parseDateTime(task.end) || new Date(start.getTime() + (task.estimate || 45) * 60000);
    const isNow = key === todayKey() && now >= start && now < end;
    const diff = Math.round((start - now) / 60000);
    let countdown;
    if (isNow) countdown = "正在进行";
    else if (key !== todayKey()) countdown = dayLabel(key);
    else if (diff <= 0) countdown = "刚刚开始";
    else if (diff < 60) countdown = `还有 ${diff} 分钟`;
    else if (diff < 24 * 60) countdown = `还有 ${Math.floor(diff / 60)} 小时 ${diff % 60} 分`;
    else countdown = `${Math.ceil(diff / 1440)} 天后`;

    $("#nextCountdown").textContent = countdown;
    $("#nextTime").textContent = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
    $("#nextTitle").textContent = task.title;
    $("#nextMeta").textContent = `${categoryLabel(task.category)} · ${minutesForTask(task)} 分钟 · ${task.fixed ? "固定日程" : "智能安排"}`;
    $("#nextAction").dataset.taskId = task.id;
  }

  function renderProgress(dayTasks) {
    const done = dayTasks.filter((task) => task.done).length;
    const total = dayTasks.length;
    const percent = total ? Math.round((done / total) * 100) : 0;
    const circumference = 2 * Math.PI * 49;
    $("#ringValue").style.strokeDasharray = String(circumference);
    $("#ringValue").style.strokeDashoffset = String(circumference * (1 - percent / 100));
    $("#progressPercent").textContent = `${percent}%`;
    $("#progressDone").textContent = done;
    $("#progressLeft").textContent = total - done;
    if (percent === 100 && total > 0) {
      $("#progressTitle").textContent = "今天的节奏，收好了。";
      $("#progressText").textContent = "所有安排都完成了，剩下的时间留给自己。";
    } else if (done === 0) {
      $("#progressTitle").textContent = total ? "从第一件开始" : "今天还没有安排";
      $("#progressText").textContent = total ? "完成一项，就离从容更近一点。" : "把脑海里的事丢进来，我帮你排好。";
    } else {
      $("#progressTitle").textContent = `已经走了 ${done} 步`;
      $("#progressText").textContent = total - done === 1 ? "还剩最后一件，保持这个节奏。" : `还剩 ${total - done} 件，不用一次做完。`;
    }
  }

  function renderRail(dayTasks) {
    const entries = buildReminders(20).filter((entry) => {
      const key = dateKey(entry.when);
      return key === todayKey() || key === dayDate || key === addDaysKey(todayKey(), 1);
    }).slice(0, 3);
    const target = $("#railReminders");
    if (!entries.length) {
      target.innerHTML = `<p class="rail-empty">接下来的 48 小时没有提醒。<br>可以放松一点。</p>`;
    } else {
      target.innerHTML = entries.map((entry) => `
        <div class="rail-reminder">
          <time>${pad2(entry.when.getHours())}:${pad2(entry.when.getMinutes())}</time>
          <div><strong>${esc(entry.task.title)}</strong><span>${esc(entry.label)} · ${esc(dayLabel(dateKey(entry.when)))}</span></div>
        </div>
      `).join("");
    }
  }

  function renderWeekGlance() {
    const start = dateKey(startOfWeek(new Date()));
    const days = Array.from({ length: 7 }, (_, i) => addDaysKey(start, i));
    const counts = days.map((key) => {
      const list = tasksForDay(key);
      return list.reduce((sum, task) => sum + minutesForTask(task), 0);
    });
    const max = Math.max(60, ...counts);
    const total = counts.reduce((a, b) => a + b, 0);
    $("#weekGlanceTotal").textContent = formatDuration(total);
    $("#weekDots").innerHTML = days.map((key, index) => {
      const d = keyDate(key);
      const h = counts[index] ? clamp(6 + Math.round((counts[index] / max) * 28), 6, 34) : 3;
      return `<button class="week-dot ${key === todayKey() ? "is-today" : ""}" data-glance-day="${key}" title="${dateLabel(key)} ${weekdayLabel(key)}">
        <span class="wd-bar-wrap"><i class="wd-bar" style="height:${h}px"></i></span>
        <span class="wd-day">${WEEKDAYS[d.getDay()]}</span><span class="wd-date">${d.getDate()}</span>
      </button>`;
    }).join("");
  }

  // ---------------------------------------------------------------------------
  // render: week

  function renderWeek() {
    const days = weekDays();
    const start = weekStartKey;
    const end = addDaysKey(start, 6);
    $("#weekRange").textContent = `${dateLabel(start)} — ${dateLabel(end)}`;

    let head = `<div class="week-head-gutter"></div>`;
    days.forEach((key) => {
      const d = keyDate(key);
      const list = tasksForDay(key);
      const load = list.reduce((sum, task) => sum + minutesForTask(task), 0);
      const loadText = load ? formatDuration(load) : "—";
      head += `<div class="week-head-cell ${key === todayKey() ? "is-today" : ""}" data-week-day="${key}" role="button" tabindex="0" title="打开 ${dateLabel(key)}">
        <div class="wh-day"><span>${WEEKDAYS[d.getDay()]}</span><b>${d.getDate()}</b></div>
        <div class="wh-meta"><span class="wh-load ${load > Number(state.settings.dailyCapacity) ? "is-over" : ""}">${loadText}</span><span>${list.length ? `${list.length} 件` : ""}</span></div>
      </div>`;
    });

    let labels = "";
    for (let hour = WEEK_START_HOUR; hour <= WEEK_END_HOUR; hour += 1) {
      labels += `<span class="week-time-label" style="top:${(hour - WEEK_START_HOUR) * HOUR_HEIGHT_WEEK}px">${pad2(hour)}:00</span>`;
    }

    let body = `<div class="week-time-col" style="height:${(WEEK_END_HOUR - WEEK_START_HOUR) * HOUR_HEIGHT_WEEK}px">${labels}</div>`;
    days.forEach((key) => {
      const list = tasksForDay(key);
      const lunchTop = (Math.max(12 * 60, WEEK_START_HOUR * 60) - WEEK_START_HOUR * 60) / 60 * HOUR_HEIGHT_WEEK;
      const lunchHeight = ((13 * 60 + 30) - 12 * 60) / 60 * HOUR_HEIGHT_WEEK;
      let blocks = "";
      list.forEach((task) => {
        const startTime = parseDateTime(task.start);
        if (!startTime) return;
        const startMin = startTime.getHours() * 60 + startTime.getMinutes();
        const endTime = parseDateTime(task.end);
        const endMin = endTime ? endTime.getHours() * 60 + endTime.getMinutes() : startMin + (task.estimate || 45);
        const top = ((Math.max(startMin, WEEK_START_HOUR * 60) - WEEK_START_HOUR * 60) / 60) * HOUR_HEIGHT_WEEK;
        const duration = Math.max(15, endMin - startMin);
        const height = Math.max((duration / 60) * HOUR_HEIGHT_WEEK, 24);
        blocks += `<article class="week-event tone-${task.category} ${task.fixed ? "is-fixed" : ""} ${task.done ? "is-done" : ""} ${duration < 35 ? "is-tiny" : ""}" data-task-id="${esc(task.id)}" style="top:${top}px;height:${height}px" title="${esc(task.title)} · ${cleanTimeRange(task.start, task.end)}">
          <div class="we-time">${cleanTimeRange(task.start, task.end)}</div>
          <div class="we-title">${esc(task.title)}</div>
        </article>`;
      });
      let now = "";
      if (key === todayKey()) {
        const n = new Date();
        const nMin = n.getHours() * 60 + n.getMinutes();
        if (nMin >= WEEK_START_HOUR * 60 && nMin <= WEEK_END_HOUR * 60) {
          now = `<div class="week-now" style="top:${((nMin - WEEK_START_HOUR * 60) / 60) * HOUR_HEIGHT_WEEK}px"></div>`;
        }
      }
      body += `<div class="week-day-col ${key === todayKey() ? "is-today" : ""} ${[0, 6].includes(keyDate(key).getDay()) ? "is-weekend" : ""}" data-week-col="${key}" style="height:${(WEEK_END_HOUR - WEEK_START_HOUR) * HOUR_HEIGHT_WEEK}px">
        <div class="lunch-band" style="top:${lunchTop}px;height:${lunchHeight}px"></div>
        ${blocks}${now}
      </div>`;
    });

    $("#weekCanvas").innerHTML = `<div class="week-head">${head}</div><div class="week-body">${body}</div>`;
    if (lastWeekRender !== start) {
      lastWeekRender = start;
      requestAnimationFrame(() => {
        const scroller = $("#weekScroll");
        scroller.scrollTop = 35;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // render: tasks

  function allOpenTasks() {
    return state.tasks.filter((task) => !task.done && !task.course);
  }

  function filterTasks() {
    let list = state.tasks.filter((task) => !task.course);
    const { status, category, query } = taskFilter;
    if (status === "open") list = list.filter((task) => !task.done);
    if (status === "scheduled") list = list.filter((task) => !task.done && task.start);
    if (status === "unscheduled") list = list.filter((task) => !task.done && !task.start);
    if (status === "done") list = list.filter((task) => task.done);
    if (category !== "all") list = list.filter((task) => task.category === category);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((task) => `${task.title} ${task.notes}`.toLowerCase().includes(q));
    }
    return list;
  }

  function taskSort(a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const aStart = parseDateTime(a.start);
    const bStart = parseDateTime(b.start);
    if (aStart && bStart && aStart - bStart) return aStart - bStart;
    if (aStart && !bStart) return -1;
    if (!aStart && bStart) return 1;
    const aDeadline = parseDateTime(a.deadline);
    const bDeadline = parseDateTime(b.deadline);
    if (aDeadline && bDeadline && aDeadline - bDeadline) return aDeadline - bDeadline;
    if (aDeadline && !bDeadline) return -1;
    if (!aDeadline && bDeadline) return 1;
    return (a.priority || 2) - (b.priority || 2);
  }

  function taskGroupFor(task, today) {
    if (task.done) return "done";
    if (task.start) {
      const start = parseDateTime(task.start);
      return start && dateKey(start) <= today ? "today" : "next";
    }
    const deadline = parseDateTime(task.deadline);
    if (deadline && dateKey(deadline) <= today) return "today";
    return "inbox";
  }

  function taskRowHTML(task, today) {
    const start = parseDateTime(task.start);
    const deadline = parseDateTime(task.deadline);
    const isOverdue = deadline && deadline < new Date() && !task.done;
    const priority = Number(task.priority) || 2;
    const chips = [];
    chips.push(`<span class="task-chip"><i class="dot dot--${task.category}"></i>${categoryLabel(task.category)}</span>`);
    if (task.fixed) chips.push(`<span class="task-chip is-fixed">固定日程</span>`);
    if (start) {
      chips.push(`<span class="task-chip">${esc(scheduleText(task))}</span>`);
    } else if (!task.done) {
      chips.push(`<span class="task-chip ${task.planWarning ? "is-warning" : ""}">${task.planWarning ? "排不下 · 请调整" : "待排程"}</span>`);
    }
    if (deadline) {
      chips.push(`<span class="task-chip ${isOverdue ? "is-warning" : "is-deadline"}">${esc(deadlineText(task))}${isOverdue ? " · 已过期" : ""}</span>`);
    }
    const priorityFlag = priority < 3
      ? `<span class="priority-flag p${priority}">${PRIORITY_LABELS[priority]}</span>`
      : "";
    return `<article class="task-row ${task.done ? "is-done" : ""} ${!task.start && !task.done ? "is-unscheduled" : ""}" data-task-row="${esc(task.id)}">
      <button class="task-check" data-task-toggle="${esc(task.id)}" aria-label="${task.done ? "取消完成" : "标记完成"}" title="${task.done ? "取消完成" : "标记完成"}">
        <svg class="icon"><use href="#i-check"></use></svg>
      </button>
      <div class="task-body" data-task-open="${esc(task.id)}" role="button" tabindex="0">
        <div class="task-title-row"><h3>${esc(task.title)}</h3>${priorityFlag}</div>
        <div class="task-meta">${chips.join("")}</div>
        ${task.notes ? `<p class="task-note">${esc(task.notes)}</p>` : ""}
      </div>
      <div class="task-actions">
        <button class="icon-btn" data-task-open="${esc(task.id)}" aria-label="编辑任务" title="编辑任务"><svg class="icon"><use href="#i-edit"></use></svg></button>
      </div>
    </article>`;
  }

  function renderTasks() {
    const list = filterTasks().sort(taskSort);
    const today = todayKey();
    const groups = { today: [], next: [], inbox: [], done: [] };
    list.forEach((task) => groups[taskGroupFor(task, today)].push(task));
    const groupTitles = { today: "今天", next: "接下来", inbox: "待排程", done: "已完成" };
    const groupHints = {
      today: "今天需要看见的事",
      next: "已经放进接下来几天",
      inbox: "还没有找到合适的位置",
      done: "做过的事，也算数"
    };

    let html = "";
    Object.keys(groups).forEach((groupKey) => {
      const items = groups[groupKey];
      if (!items.length) return;
      html += `<section class="task-group">
        <div class="task-group-head"><h3>${groupTitles[groupKey]}</h3><span>${items.length} 件 · ${groupHints[groupKey]}</span></div>
        ${items.map((task) => taskRowHTML(task, today)).join("")}
      </section>`;
    });

    if (!html) {
      html = `<div class="task-empty">
        <span class="empty-orbit"><svg class="icon"><use href="#i-inbox"></use></svg></span>
        <h3>${taskFilter.status === "done" ? "还没有完成的任务" : "任务箱是空的"}</h3>
        <p>${state.tasks.some((task) => task.course) ? "课程表已经放进「行程」页；任务箱只收集你的临时事项。" : (taskFilter.status === "unscheduled" ? "所有任务都找到位置了，很好。" : "把脑海里悬着的小事丢进来，我帮你排。")}</p>
        <button class="btn btn--primary" data-add-task>添加第一件事</button>
      </div>`;
    }

    $("#taskList").innerHTML = html;
    $("#taskCount").textContent = `${list.length} 个任务`;
    $("#tabOpenCount").textContent = allOpenTasks().length;

    const scheduled = allOpenTasks().filter((task) => task.start).length;
    const unscheduled = allOpenTasks().filter((task) => !task.start).length;
    const high = allOpenTasks().filter((task) => Number(task.priority) === 1).length;
    $("#sumOpen").textContent = allOpenTasks().length;
    $("#sumScheduled").textContent = scheduled;
    $("#sumUnscheduled").textContent = unscheduled;
    $("#sumHigh").textContent = high;
    const weekStart = dateKey(startOfWeek(new Date()));
    const weekEnd = addDaysKey(weekStart, 6);
    const weekTasks = state.tasks.filter((task) => {
      if (task.course) return false;
      const start = parseDateTime(task.start);
      const deadline = parseDateTime(task.deadline);
      return (start && dateKey(start) >= weekStart && dateKey(start) <= weekEnd)
        || (deadline && dateKey(deadline) >= weekStart && dateKey(deadline) <= weekEnd);
    });
    const rate = weekTasks.length ? Math.round((weekTasks.filter((task) => task.done).length / weekTasks.length) * 100) : 0;
    $("#sumRate").textContent = `${rate}%`;
    $("#sumRateBar").style.width = `${rate}%`;
    $$("#taskTabs button").forEach((button) => button.classList.toggle("is-active", button.dataset.status === taskFilter.status));
  }

  // ---------------------------------------------------------------------------
  // render: reminders

  function renderReminders() {
    const entries = buildReminders(50);
    const groups = new Map();
    entries.forEach((entry) => {
      const key = dateKey(entry.when);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    });
    $("#reminderCount").textContent = `${entries.length} 条`;

    let listHTML = "";
    groups.forEach((items, key) => {
      listHTML += `<div class="reminder-group"><div class="reminder-group-title">${dayLabel(key)} · ${dateLabel(key)} ${weekdayLabel(key)}</div>
        ${items.map((entry) => `<div class="reminder-row">
          <div class="reminder-time">${pad2(entry.when.getHours())}:${pad2(entry.when.getMinutes())}<small>${entry.kind === "deadline" ? "截止" : "开始"}</small></div>
          <div class="reminder-body"><strong>${esc(entry.task.title)}</strong><span>${entry.kind === "deadline" ? "截止" : "开始"} ${cleanTimeRange(entry.when, entry.kind === "deadline" ? null : entry.task.end)} · ${categoryLabel(entry.task.category)}</span></div>
          <span class="reminder-lead ${entry.kind === "deadline" ? "is-deadline" : ""}">${esc(entry.label)}</span>
        </div>`).join("")}
      </div>`;
    });
    if (!listHTML) {
      listHTML = `<div class="reminder-empty"><svg class="icon"><use href="#i-bell"></use></svg><h3>接下来没有提醒</h3><p>给任务一个时间，我就会在合适的时候叫你。</p></div>`;
    }
    $("#reminderList").innerHTML = listHTML;

    renderChannelCard();
    renderEventHistory();
    $$("[data-quick-setting]").forEach((el) => {
      el.checked = Boolean(state.settings[el.dataset.quickSetting]);
    });
    const quickLead = $("#quickLead");
    if (quickLead) quickLead.value = String(state.settings.defaultLead);

    const webhook = state.settings.webhook;
    const webhookSummary = $("#webhookSummary");
    if (webhookSummary) {
      const kindLabel = { auto: "自动识别", wecom: "企业微信", feishu: "飞书", dingtalk: "钉钉", serverchan: "Server酱", ntfy: "ntfy", custom: "自定义 Webhook" }[webhook.type] || "Webhook";
      webhookSummary.innerHTML = `<p class="section-kicker">MOBILE</p><h3>手机消息</h3>
        <p>${webhook.enabled && webhook.url ? `已启用 ${esc(kindLabel)}，提醒会同时发到手机。` : "想让提醒跟到手机上？可以接入群机器人或 Server酱。"}</p>
        <span class="webhook-state"><i class="dot ${webhook.enabled && webhook.url ? "dot--health" : "dot--other"}"></i>${webhook.enabled && webhook.url ? "已接通" : "未启用"}</span>
        ${webhook.enabled && webhook.url && webhook.type === "ntfy" ? `<a class="btn btn--soft webhook-open" href="${esc(webhook.url)}" target="_blank" rel="noopener">打开 ntfy 订阅页</a>` : ""}
        <button class="text-btn text-btn--arrow" data-view="settings">去设置消息通道 <svg class="icon icon--tiny"><use href="#i-arrow-right"></use></svg></button>`;
    }
  }

  function renderChannelCard() {
    const card = $("#channelCard");
    if (!card) return;
    const remote = !["127.0.0.1", "localhost", "::1"].includes(location.hostname);
    const webhook = state.settings.webhook || {};
    const phonePush = Boolean(webhook.enabled && webhook.url);
    if (CLOUD_MODE) {
      card.innerHTML = `<span class="channel-icon"><svg class="icon"><use href="#i-server"></use></svg></span>
        <div class="channel-copy"><p class="section-kicker">CLOUD SYNC</p><h3>${phonePush ? "云端提醒已接通" : "云端同步已连接"}</h3>
        <p>${phonePush ? "手机和电脑共享同一份数据；到点后由云端定时任务通过企业微信提醒你，不依赖电脑开机。" : "手机和电脑登录同一账号即可同步。手机通知需要先在「手机消息通道」配置企业微信机器人。"}</p></div>
        <div class="channel-actions"><span class="channel-badge"><i class="status-dot"></i>${phonePush ? "推送已接通" : "待配置提醒"}</span>${phonePush ? `<button class="btn btn--soft" data-channel-test="webhook">测试手机推送</button>` : `<button class="btn btn--soft" data-view="settings">去设置手机消息</button>`}</div>`;
      return;
    }
    if (serverMode && remote) {
      card.innerHTML = `<span class="channel-icon"><svg class="icon"><use href="#i-smartphone"></use></svg></span>
        <div class="channel-copy"><p class="section-kicker">PHONE VIEW</p><h3>${phonePush ? "手机推送已开启" : "手机已连到电脑上的日序"}</h3>
        <p>${phonePush ? "提醒会同时发到手机；电脑保持开机、日序进程运行时，即使手机浏览器关掉也能收到。" : "Windows 通知会弹在电脑上。想在手机上也收到，请配置一次「手机消息通道」；配置后关掉手机浏览器也能收到。"}</p></div>
        <div class="channel-actions"><span class="channel-badge"><i class="status-dot"></i>${phonePush ? "推送已接通" : "已连接"}</span><button class="btn btn--soft" data-view="settings">${phonePush ? "查看手机设置" : "设置手机消息"}</button></div>`;
      return;
    }
    if (serverMode) {
      const on = state.settings.nativeEnabled;
      card.innerHTML = `<span class="channel-icon"><svg class="icon"><use href="#i-server"></use></svg></span>
        <div class="channel-copy"><p class="section-kicker">LOCAL SERVICE</p><h3>${on ? "本机提醒已就绪" : "本机提醒已关闭"}</h3>
        <p>${on ? "本地助理正在运行，关掉浏览器也会在到点时提醒你。" : "可以在设置里打开 Windows 通知，或使用手机消息通道。"}</p></div>
        <div class="channel-actions"><span class="channel-badge"><i class="status-dot"></i>助理运行中</span><button class="btn btn--soft" data-channel-test="native">测试通知</button></div>`;
      return;
    }
    const granted = notificationSupported() && Notification.permission === "granted";
    card.innerHTML = `<span class="channel-icon"><svg class="icon"><use href="#i-smartphone"></use></svg></span>
      <div class="channel-copy"><p class="section-kicker">BROWSER MODE</p><h3>${granted ? "浏览器提醒已开启" : "启动本地助理，关页也能提醒"}</h3>
      <p>${granted ? "页面在后台时可以使用浏览器通知；关掉浏览器则需要本地助理。" : "当前是静态网页模式，只有页面打开时才可能提醒。"}</p></div>
      <div class="channel-actions"><span class="channel-badge">未连接本地服务</span>
      ${granted ? `<button class="btn btn--soft" data-channel-test="browser">测试提醒</button>` : `<button class="btn btn--soft" data-enable-browser>开启浏览器通知</button>`}
      <button class="btn btn--soft" data-show-start>怎么启动</button></div>`;
  }

  function renderEventHistory() {
    const events = serverMode ? serverEvents.slice().reverse() : (state.meta.events || []).slice().reverse();
    const target = $("#eventHistory");
    if (!target) return;
    if (!events.length) {
      target.innerHTML = `<p class="empty-copy">还没有发出过提醒。到了时间，这里会留下记录。</p>`;
      return;
    }
    target.innerHTML = events.slice(0, 12).map((event) => {
      const at = parseDateTime(event.at);
      const time = at ? `${shortDate(dateKey(at))} ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : "";
      return `<div class="event-row"><span class="event-icon"><svg class="icon"><use href="${event.kind === "deadline" ? "#i-alert" : "#i-bell"}"></use></svg></span>
        <div><strong>${esc(event.title || "提醒")}</strong><span>${esc(event.body || "")}</span></div><time>${time}</time></div>`;
    }).join("");
  }

  // ---------------------------------------------------------------------------
  // render: settings

  async function refreshServerMeta() {
    if (!serverMode) return;
    try {
      serverMeta = await api("/api/meta");
      renderServerStatus();
      if (currentView === "settings") renderSettings();
    } catch {
      serverMode = false;
      renderServerStatus();
    }
  }

  function renderSettings() {
    $$("#view-settings [data-setting]").forEach((el) => {
      const key = el.dataset.setting;
      if (!hasOwn(state.settings, key)) return;
      if (el.type === "checkbox") el.checked = Boolean(state.settings[key]);
      else el.value = state.settings[key] ?? "";
    });
    $$("#view-settings [data-webhook]").forEach((el) => {
      const key = el.dataset.webhook;
      const webhook = state.settings.webhook || {};
      if (el.type === "checkbox") el.checked = Boolean(webhook[key]);
      else el.value = webhook[key] ?? "";
    });
    const secretField = $("#webhookSecretField");
    if (secretField) secretField.hidden = state.settings.webhook.type !== "dingtalk";
    const statusPill = $("#webhookStatusPill");
    if (statusPill) {
      const on = Boolean(state.settings.webhook.enabled && state.settings.webhook.url);
      statusPill.textContent = on ? "已启用" : "未启用";
      statusPill.classList.toggle("is-on", on);
    }
    const details = $("#serverDetail");
    if (details) {
      if (CLOUD_MODE) {
        details.innerHTML = `<span><i class="status-dot"></i>云端已连接</span>
          <span>Supabase</span>
          ${serverMeta?.userEmail ? `<span>${esc(serverMeta.userEmail)}</span>` : ""}
          <span>${serverMeta?.webhookConfigured ? "云端提醒已接通" : "手机提醒待配置"}</span>`;
      } else if (serverMode) {
        details.innerHTML = `<span><i class="status-dot"></i>服务运行中</span>
          <span>端口 ${esc(location.port || "8765")}</span>
          ${serverMeta?.pid ? `<span>PID ${esc(serverMeta.pid)}</span>` : ""}
          <span>${state.settings.nativeEnabled ? "Windows 通知已开启" : "Windows 通知已关闭"}</span>
          <span>${serverMeta?.webhookConfigured ? "手机消息已接通" : "手机消息未启用"}</span>`;
      } else {
        details.innerHTML = `<span><i class="status-dot" style="background:var(--gold)"></i>静态预览模式</span><span>关页后无法提醒</span><span>运行 start.bat 启动本地助理</span>`;
      }
    }
    const dataPath = $("#dataPath");
    if (dataPath) dataPath.textContent = CLOUD_MODE ? "Supabase · planner_state（云端）" : (serverMeta?.dataFile || "浏览器本地存储（localStorage）");
    const phoneUrl = $("#phoneUrl");
    const phoneNote = $("#phoneNote");
    if (phoneUrl && phoneNote) {
      if (CLOUD_MODE) {
        phoneUrl.textContent = location.origin;
        phoneNote.textContent = "电脑和手机打开同一个网址，登录同一账号即可同步，不需要连同一个 Wi-Fi，也不需要保持电脑开机。";
      } else if (serverMode && serverMeta?.lanEnabled && serverMeta?.lanUrl) {
        phoneUrl.textContent = serverMeta.lanUrl;
        phoneNote.textContent = "手机和电脑连同一个 Wi-Fi，在浏览器打开上面的地址（无密码，建议只在可信网络使用）。打不开就双击 allow-firewall.bat。手机系统通知需要 HTTPS，请用下方「手机消息通道」接收提醒。";
      } else if (serverMode) {
        phoneUrl.textContent = "未开启 · 双击 start-phone.bat";
        phoneNote.textContent = "当前只允许本机访问。停止日序后双击 start-phone.bat，即可让同一 Wi-Fi 下的手机打开；首次可能需要在 Windows 防火墙中允许 Python。";
      } else {
        phoneUrl.textContent = "本地助理未运行";
        phoneNote.textContent = "双击 start-phone.bat 启动手机访问模式。手机通知需要配置「手机消息通道」。";
      }
    }
    $("#dataTaskCount").textContent = state.tasks.length;
    $("#dataEventCount").textContent = (serverMode ? serverEvents.length : (state.meta.events || []).length);
    const created = parseDateTime(state.meta.createdAt);
    $("#dataDays").textContent = created ? Math.max(1, Math.ceil((Date.now() - created.getTime()) / 86400000)) : 1;
    const auto = $("#autostartToggle");
    if (auto) {
      auto.checked = Boolean(serverMeta?.autostart);
      auto.closest(".rule-row")?.toggleAttribute("hidden", CLOUD_MODE);
    }
    const shutdown = $("#shutdownBtn");
    if (shutdown) {
      shutdown.disabled = !serverMode;
      shutdown.hidden = CLOUD_MODE;
    }
    const restartHint = $("#restartHintBtn");
    if (restartHint) restartHint.hidden = CLOUD_MODE;
    const testWebhook = $("#testWebhookBtn");
    if (testWebhook) testWebhook.disabled = !serverMode && !CLOUD_MODE;
    renderAISettings();
  }

  // ---------------------------------------------------------------------------
  // toasts & confirm

  function showToast(title, body = "", type = "default", duration = 5600) {
    const stack = $("#toastStack");
    if (!stack) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type === "warn" ? "is-warn" : ""} ${type === "success" ? "is-success" : ""}`;
    const icon = type === "warn" ? "i-alert" : type === "success" ? "i-check" : "i-bell";
    toast.innerHTML = `<span class="toast-icon"><svg class="icon"><use href="#${icon}"></use></svg></span>
      <div class="toast-body"><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ""}</div>
      <button class="toast-close" aria-label="关闭"><svg class="icon icon--tiny"><use href="#i-x"></use></svg></button>`;
    const remove = () => {
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 220);
    };
    toast.querySelector(".toast-close").addEventListener("click", remove);
    stack.appendChild(toast);
    while (stack.children.length > 4) stack.firstElementChild.remove();
    setTimeout(remove, duration);
  }

  function askConfirm(title, text, confirmLabel = "确认") {
    return new Promise((resolve) => {
      confirmResolver = resolve;
      $("#confirmTitle").textContent = title;
      $("#confirmText").textContent = text;
      $("#confirmOk").textContent = confirmLabel;
      $("#confirmModal").hidden = false;
      $("#confirmModal").setAttribute("aria-hidden", "false");
      setTimeout(() => $("#confirmCancel").focus(), 30);
    });
  }

  function closeConfirm(result) {
    $("#confirmModal").hidden = true;
    $("#confirmModal").setAttribute("aria-hidden", "true");
    if (confirmResolver) {
      const resolve = confirmResolver;
      confirmResolver = null;
      resolve(result);
    }
  }

  // ---------------------------------------------------------------------------
  // capture / parser UI

  function previewDateValue(draft) {
    if (draft.fixed) return draft.start || "";
    return draft.deadline || "";
  }

  function syncDraftsFromPreview() {
    $$("#parsePreview .preview-item[data-draft-index]").forEach((item) => {
      const index = Number(item.dataset.draftIndex);
      const draft = parsedDrafts[index];
      if (!draft) return;
      const titleInput = $("[data-draft-title]", item);
      const categoryInput = $("[data-draft-category]", item);
      const modeInput = $("[data-draft-mode]", item);
      const whenInput = $("[data-draft-when]", item);
      const minutesInput = $("[data-draft-minutes]", item);
      if (titleInput) draft.title = (titleInput.value.trim() || draft.title).slice(0, 80);
      if (categoryInput) draft.category = categoryInput.value;
      draft.estimate = clamp(Number(minutesInput?.value) || draft.estimate || 45, 15, 240);
      const when = whenInput?.value || "";
      if (modeInput?.value === "fixed" && when) {
        const date = dateKey(parseDateTime(when));
        const newStartMinutes = minutesFromTime(when.slice(11, 16));
        if (Array.isArray(draft.repeatOccurrences) && draft.repeatOccurrences.length) {
          const oldFirst = parseDateTime(draft.repeatOccurrences[0].start);
          const newFirst = parseDateTime(when);
          const dayShift = Math.round((startOfDay(newFirst).getTime() - startOfDay(oldFirst).getTime()) / 86400000);
          draft.repeatOccurrences = draft.repeatOccurrences.map((occurrence) => {
            const shiftedDate = addDaysKey(occurrence.date, dayShift);
            return {
              ...occurrence,
              date: shiftedDate,
              start: combineDateTime(shiftedDate, newStartMinutes),
              end: combineDateTime(shiftedDate, newStartMinutes + draft.estimate)
            };
          });
          draft.start = draft.repeatOccurrences[0].start;
          draft.end = draft.repeatOccurrences[0].end;
          draft.dateKey = draft.repeatOccurrences[0].date;
        } else {
          draft.fixed = true;
          draft.start = when;
          draft.end = combineDateTime(date, newStartMinutes + draft.estimate);
          draft.deadline = null;
          draft.availableFrom = null;
          draft.dateKey = date;
        }
      } else {
        draft.repeatOccurrences = null;
        draft.repeatLabel = "";
        draft.fixed = false;
        draft.start = null;
        draft.end = null;
        draft.deadline = when || null;
        if (when) draft.dateKey = dateKey(parseDateTime(when));
      }
    });
  }

  function taskWhenLabel(task) {
    const start = parseDateTime(task.start);
    if (start) return `${shortDate(dateKey(start))} ${cleanTimeRange(task.start, task.end)}`;
    const deadline = parseDateTime(task.deadline);
    if (deadline) return `截止 ${shortDate(dateKey(deadline))} ${String(task.deadline).slice(11, 16)}`;
    return "未排时间";
  }

  function renderActionPreview() {
    const panel = $("#parsePreview");
    panel.hidden = false;
    if (!parsedActions.length) {
      panel.innerHTML = `<div class="preview-empty">${esc(managementReply || "没有找到要修改的日程。可以说得更具体一点，比如「删除 11 月 18 日的学生会值班」。")}</div>
        <div class="preview-actions"><button class="btn btn--ghost" data-preview-cancel>收起</button></div>`;
      return;
    }
    const items = parsedActions.map((action, index) => {
      const before = action.before;
      const title = action.changes?.title || before.title;
      const after = action.type === "update" ? { ...before, ...action.changes } : before;
      const detail = action.type === "delete"
        ? `删除 · ${esc(taskWhenLabel(before))}`
        : `${esc(taskWhenLabel(before))} → ${esc(taskWhenLabel(after))}`;
      return `<div class="preview-item">
        <span class="preview-index">${pad2(index + 1)}</span>
        <div class="preview-body">
          <strong class="preview-action-title">${action.type === "delete" ? "删除" : "修改"}：${esc(title)}</strong>
          <div class="preview-chips"><span>${detail}</span></div>
        </div>
      </div>`;
    }).join("");
    panel.innerHTML = `<div class="preview-head"><strong>我准备这样改</strong><span>${esc(managementReply || "确认后会立即更新日程")}</span></div>
      <div class="preview-list">${items}</div>
      <div class="preview-actions"><button class="btn btn--ghost" data-preview-cancel>取消</button><button class="btn btn--primary" data-preview-confirm>确认修改</button></div>`;
  }

  function applyParsedActions() {
    if (!parsedActions.length) return;
    let changed = 0;
    let needsPlan = false;
    parsedActions.forEach((action) => {
      const index = state.tasks.findIndex((task) => task.id === action.taskId);
      if (index < 0) return;
      if (action.type === "delete") {
        state.tasks.splice(index, 1);
        changed += 1;
        return;
      }
      if (action.type === "update") {
        const task = state.tasks[index];
        Object.assign(task, action.changes);
        task.planWarning = false;
        if (action.changes.start) {
          task.fixed = true;
          task.deadline = null;
        }
        if (action.changes.fixed === false || action.changes.deadline) needsPlan = true;
        if (action.changes.estimate) needsPlan = true;
        changed += 1;
      }
    });
    if (needsPlan) autoPlan();
    state.meta.lastPlanAt = new Date().toISOString();
    saveState();
    parsedActions = [];
    parsedDrafts = [];
    managementReply = "";
    $("#parsePreview").hidden = true;
    $("#captureInput").value = "";
    renderAll();
    setCaptureMode("add");
    showToast("日程已更新", `${changed} 项修改已生效。`, "success");
  }

  function renderParsePreview() {
    if (parsedActions.length || (managementReply && !parsedDrafts.length)) {
      renderActionPreview();
      return;
    }
    const panel = $("#parsePreview");
    if (!parsedDrafts.length) {
      panel.hidden = false;
      panel.innerHTML = `<div class="preview-empty">还没有识别出具体的事。试着写成「明天下午3点开会」或「周五前交报告」。</div>
        <div class="preview-actions"><button class="btn btn--ghost" data-preview-cancel>收起</button></div>`;
      return;
    }
    panel.hidden = false;
    const items = parsedDrafts.map((draft, index) => {
      const dateInfo = draft.fixed
        ? `${dayLabel(draft.dateKey)} ${cleanTimeRange(draft.start, draft.end)}`
        : draft.deadline
          ? `截止 ${dayLabel(dateKey(parseDateTime(draft.deadline)))} ${cleanTimeRange(draft.deadline, null)}`
          : draft.availableFrom
            ? `${dayLabel(draft.availableFrom)}开始`
            : "自动找空档";
      const whenValue = previewDateValue(draft);
      const repeatInfo = Array.isArray(draft.repeatOccurrences) && draft.repeatOccurrences.length
        ? `${draft.repeatLabel || "重复"} · ${shortDate(draft.repeatOccurrences[0].date)} 起`
        : "";
      return `<div class="preview-item" data-draft-index="${index}">
        <span class="preview-index">${pad2(index + 1)}</span>
        <div class="preview-body">
          <input class="preview-title-input" data-draft-title value="${esc(draft.title)}" aria-label="任务标题" maxlength="80">
          <div class="preview-chips"><span>${draft.fixed ? "固定" : "智能"}</span><span>${esc(dateInfo)}</span><span>${esc(categoryLabel(draft.category))}</span><span>${draft.estimate} 分钟</span>${draft.priority === 1 ? "<span>紧急</span>" : ""}${repeatInfo ? `<span>${esc(repeatInfo)}</span>` : (draft.repeat ? `<span>${draft.repeat}重复 · 先排下一次</span>` : "")}</div>
          <div class="preview-fields">
            <label class="preview-field"><span>类型</span><select data-draft-mode><option value="auto"${draft.fixed ? "" : " selected"}>智能安排</option><option value="fixed"${draft.fixed ? " selected" : ""}>固定时间</option></select></label>
            <label class="preview-field"><span>${draft.fixed ? "开始" : "截止（可空）"}</span><input type="datetime-local" data-draft-when value="${esc(whenValue)}"></label>
            <label class="preview-field"><span>用时（分钟）</span><input type="number" data-draft-minutes min="15" max="240" step="15" value="${clamp(draft.estimate || 45, 15, 240)}"></label>
            <label class="preview-field preview-field--category"><span>分类</span><select data-draft-category>${CATEGORY_ORDER.map((category) => `<option value="${category}"${draft.category === category ? " selected" : ""}>${categoryLabel(category)}</option>`).join("")}</select></label>
          </div>
        </div>
        <div class="preview-tools">
          <button class="preview-remove preview-edit-btn" data-preview-edit="${index}" aria-label="调整这一条" title="调整时间/分类"><svg class="icon icon--tiny"><use href="#i-edit"></use></svg></button>
          <button class="preview-remove" data-preview-remove="${index}" aria-label="移除这一条" title="移除这一条"><svg class="icon icon--tiny"><use href="#i-x"></use></svg></button>
        </div>
      </div>`;
    }).join("");
    panel.innerHTML = `<div class="preview-head"><strong>我读到了 ${parsedDrafts.length} 件事</strong><span>可以直接改标题，或点右侧铅笔调整时间</span></div>
      <div class="preview-list">${items}</div>
      <div class="preview-actions"><button class="btn btn--ghost" data-preview-cancel>取消</button><button class="btn btn--primary" data-preview-confirm>全部加入并排程</button></div>`;
  }

  async function handleCaptureSubmit() {
    const input = $("#captureInput");
    const text = input.value.trim();
    if (!text) {
      input.focus();
      showToast("先写点什么", "比如：明天下午3点和导师开会。", "warn");
      return;
    }
    const manageIntent = /(删除|删掉|去掉|取消|改到|改成|修改|调整|移到|挪到|换成|推迟|延后|提前|标记为完成|标记完成)/.test(text);
    const looksLikeNewEvent = /(今天|明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|上午|下午|中午|晚上|早上|今晚|明晚|\d{1,2}\s*[:：点])/.test(text);
    if (captureMode === "manage" && !manageIntent && looksLikeNewEvent) {
      setCaptureMode("add");
      showToast("已切回「新建」", "这句话带日期/时间，像是在安排新日程。", "default", 5000);
    }
    if (captureMode !== "manage" && manageIntent) {
      setCaptureMode("manage");
      showToast("已切到「管理日程」", "这句话看起来是在改已有安排，确认后才会生效。", "default", 5000);
    }
    if (captureMode === "manage") {
      if (!aiEnabled()) {
        showToast("管理日程需要 AI", "先到 设置 → AI 智能解析 填入 DeepSeek API Key。", "warn", 9000);
        return;
      }
      setCaptureBusy(true);
      try {
        const result = await parseManagementWithAI(text);
        parsedActions = result.actions;
        managementReply = result.reply;
        parsedDrafts = [];
        if (!parsedActions.length) {
          showToast("没有找到要改的日程", result.reply || "可以说得更具体一点。", "warn", 9000);
        }
        renderParsePreview();
      } catch (error) {
        showToast("AI 管理失败", String(error.message || error), "warn", 9000);
      } finally {
        setCaptureBusy(false);
      }
      return;
    }
    parsedActions = [];
    managementReply = "";
    const multiWeekday = /每(?:周|星期|礼拜)|每个?[单双]周/.test(text) && extractWeekdays(text).length > 1;
    const useAI = aiEnabled() && !multiWeekday;
    if (useAI) setCaptureBusy(true);
    try {
      if (useAI) {
        try {
          parsedDrafts = await parseWithAI(text);
        } catch (error) {
          parsedDrafts = parseNaturalInput(text);
          showToast("AI 解析失败，已用本地规则", String(error.message || error), "warn", 9000);
        }
      } else {
        parsedDrafts = parseNaturalInput(text);
      }
    } finally {
      setCaptureBusy(false);
    }
    if (!parsedDrafts.length) {
      showToast("这次没太听懂", "试试带上时间，例如「明天下午3点开会」。", "warn");
    }
    renderParsePreview();
  }

  function commitDrafts(drafts) {
    if (!drafts.length) return;
    const now = new Date().toISOString();
    let added = 0;
    drafts.forEach((draft) => {
      const occurrences = Array.isArray(draft.repeatOccurrences) && draft.repeatOccurrences.length
        ? draft.repeatOccurrences
        : [null];
      occurrences.forEach((occurrence) => {
        const task = normalizeTask({
          id: uid(),
          title: draft.title,
          notes: draft.notes + (draft.repeatLabel ? ` · ${draft.repeatLabel}` : ""),
          category: draft.category,
          priority: draft.priority,
          estimate: draft.estimate,
          fixed: draft.fixed,
          start: occurrence?.start || draft.start,
          end: occurrence?.end || draft.end,
          deadline: occurrence ? null : draft.deadline,
          availableFrom: occurrence ? null : draft.availableFrom,
          reminderLead: draft.reminderLead,
          done: false,
          createdAt: now,
          demo: false
        });
        if (task) {
          state.tasks.push(task);
          added += 1;
        }
      });
    });
    const result = autoPlan();
    state.meta.seeded = true;
    state.meta.demo = state.tasks.some((task) => task.demo);
    saveState();
    parsedDrafts = [];
    parsedActions = [];
    managementReply = "";
    $("#parsePreview").hidden = true;
    $("#captureInput").value = "";
    renderAll();
    const message = result.unscheduled
      ? `${added} 件已加入行程，${result.unscheduled} 件暂时排不下。`
      : `${added} 件已加入行程。`;
    const repeatNote = drafts.some((draft) => Array.isArray(draft.repeatOccurrences) && draft.repeatOccurrences.length)
      ? " 重复事项已按单/双周展开。"
      : "";
    showToast("已经替你排好", message + repeatNote, result.unscheduled ? "warn" : "success");
  }

  // ---------------------------------------------------------------------------
  // task modal

  function setMode(mode) {
    currentMode = mode;
    $$("#modeSwitch button").forEach((button) => button.classList.toggle("is-active", button.dataset.mode === mode));
    $("#autoFields").hidden = mode !== "auto";
    $("#fixedFields").hidden = mode !== "fixed";
    if (mode === "fixed") {
      const dateInput = $("#taskDate");
      if (!dateInput.value) dateInput.value = dayDate;
      const timeInput = $("#taskStart");
      if (!timeInput.value) timeInput.value = "09:00";
    }
  }

  function setCategory(category) {
    currentCategory = category;
    $$("#categoryPicker button").forEach((button) => button.classList.toggle("is-active", button.dataset.category === category));
  }

  function setPriority(priority) {
    currentPriority = Number(priority);
    $$("#priorityPicker button").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.priority) === currentPriority));
  }

  function openTaskModal({ taskId = null, mode = "auto", date = dayDate, title = "", startTime = "" } = {}) {
    editingTaskId = taskId;
    const task = taskId ? state.tasks.find((item) => item.id === taskId) : null;
    $("#taskModal").hidden = false;
    $("#taskModal").setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    $("#modalKicker").textContent = task ? "EDIT TASK" : "NEW TASK";
    $("#modalTitle").textContent = task ? "调整这件事" : "添加一件事";
    $("#saveTaskBtn").textContent = task ? "保存修改" : "加入行程";
    $("#deleteTaskBtn").hidden = !task;
    $("#taskForm").reset();
    $("#taskId").value = task ? task.id : "";
    $("#taskTitle").value = task ? task.title : title;
    $("#taskNotes").value = task ? task.notes : "";

    const fixed = task ? task.fixed : mode === "fixed";
    setMode(fixed ? "fixed" : "auto");
    setCategory(task ? task.category : "work");
    setPriority(task ? task.priority : 2);
    $("#taskEstimate").value = task ? clamp(task.estimate || 45, 15, 240) : clamp(state.settings.defaultDuration || 45, 15, 240);
    $("#taskReminder").value = task && task.reminderLead !== null ? String(task.reminderLead) : "";

    if (task) {
      $("#taskDeadline").value = toLocalInput(task.deadline);
      $("#taskAvailable").value = task.availableFrom || "";
      if (task.start) {
        const start = parseDateTime(task.start);
        $("#taskDate").value = dateKey(start);
        $("#taskStart").value = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
        $("#taskDuration").value = clamp(minutesForTask(task), 15, 720);
      }
    } else {
      $("#taskDeadline").value = "";
      $("#taskAvailable").value = "";
      $("#taskDate").value = date || todayKey();
      $("#taskStart").value = startTime || "09:00";
      $("#taskDuration").value = clamp(state.settings.defaultDuration || 60, 15, 720);
    }

    if (!task && mode === "fixed") {
      setMode("fixed");
    }
    setTimeout(() => $("#taskTitle").focus(), 80);
  }

  function closeTaskModal() {
    $("#taskModal").hidden = true;
    $("#taskModal").setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    editingTaskId = null;
  }

  function saveTaskFromForm(event) {
    event.preventDefault();
    const title = $("#taskTitle").value.trim();
    if (!title) {
      $("#taskTitle").focus();
      $("#taskTitle").reportValidity();
      return;
    }
    const existing = editingTaskId ? state.tasks.find((task) => task.id === editingTaskId) : null;
    const base = existing ? { ...existing } : {
      id: uid(),
      done: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      demo: false,
      planWarning: false
    };
    base.title = title.slice(0, 120);
    base.notes = $("#taskNotes").value.trim().slice(0, 1000);
    base.category = currentCategory;
    base.priority = currentPriority;
    base.course = false;
    base.reminderLead = $("#taskReminder").value === "" ? null : clamp(Number($("#taskReminder").value), 0, 2880);

    if (currentMode === "fixed") {
      const date = $("#taskDate").value || dayDate || todayKey();
      const time = $("#taskStart").value || "09:00";
      const startMin = minutesFromTime(time);
      const duration = Math.min(clamp(Number($("#taskDuration").value) || 60, 15, 720), Math.max(15, 23 * 60 + 59 - startMin));
      base.fixed = true;
      base.start = `${date}T${time}`;
      base.end = combineDateTime(date, startMin + duration);
      base.estimate = Math.min(duration, 720);
      base.deadline = null;
      base.availableFrom = null;
    } else {
      const estimate = clamp(Number($("#taskEstimate").value) || 45, 15, 240);
      base.fixed = false;
      base.start = null;
      base.end = null;
      base.estimate = estimate;
      base.deadline = $("#taskDeadline").value ? stripSeconds($("#taskDeadline").value) : null;
      base.availableFrom = $("#taskAvailable").value || null;
      base.planWarning = false;
    }

    const task = normalizeTask(base);
    if (!task) return;
    if (existing) {
      const index = state.tasks.findIndex((item) => item.id === existing.id);
      state.tasks[index] = task;
    } else {
      state.tasks.push(task);
    }
    state.meta.seeded = true;
    state.meta.demo = state.tasks.some((item) => item.demo);
    const result = autoPlan();
    saveState();
    closeTaskModal();
    renderAll();
    if (currentView === "tasks") renderTasks();
    showToast(existing ? "已经更新" : "已经加入行程", result.unscheduled ? "有任务暂时排不下，去任务箱调整一下截止时间。" : "时间已经重新排好了。", result.unscheduled ? "warn" : "success");
  }

  async function deleteTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const confirmed = await askConfirm("删除这件事？", `「${task.title}」会从任务箱和行程里一起移除。`, "删除");
    if (!confirmed) return;
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    autoPlan();
    saveState();
    closeTaskModal();
    renderAll();
    showToast("已经删除", "这件小事从清单里移除了。", "default");
  }

  function toggleTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    task.done = !task.done;
    task.completedAt = task.done ? new Date().toISOString() : null;
    saveState();
    renderAll();
    if (task.done) showToast("完成一件", `「${task.title}」，做得很好。`, "success", 3200);
  }

  // ---------------------------------------------------------------------------
  // navigation

  const VIEW_TITLES = { today: "今日", plan: "行程", tasks: "任务箱", reminders: "提醒", settings: "设置" };

  function navigate(view, { updateHash = true } = {}) {
    if (!VIEW_TITLES[view]) view = "today";
    currentView = view;
    $$(".view").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.viewPanel === view));
    $$("[data-view]").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active && (button.classList.contains("nav-item") || button.classList.contains("mobile-nav") || button.closest(".mobile-nav")));
    });
    if (updateHash) history.replaceState(null, "", `#${view}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
    renderCommon();
    if (view === "today") renderToday();
    if (view === "plan") renderWeek();
    if (view === "tasks") renderTasks();
    if (view === "reminders") renderReminders();
    if (view === "settings") {
      renderSettings();
      refreshServerMeta();
    }
    $("#bellPopover").hidden = true;
    $("#bellBtn").setAttribute("aria-expanded", "false");
  }

  // ---------------------------------------------------------------------------
  // full render

  function renderAll() {
    renderCommon();
    if (currentView === "today") renderToday();
    if (currentView === "plan") renderWeek();
    if (currentView === "tasks") renderTasks();
    if (currentView === "reminders") renderReminders();
    if (currentView === "settings") renderSettings();
  }

  // ---------------------------------------------------------------------------
  // settings interactions

  function markSettingsDirty(key) {
    if (["workStart", "workEnd", "lunchStart", "lunchEnd", "eveningEnabled", "eveningStart", "eveningEnd", "dailyCapacity", "defaultDuration", "buffer"].includes(key)) {
      autoPlan();
      renderAll();
    }
    saveState();
    if (key === "userName") renderCommon();
  }

  function handleSettingChange(el) {
    const key = el.dataset.setting;
    if (!key) return;
    let value;
    if (el.type === "checkbox") value = el.checked;
    else if (el.type === "number") value = Number(el.value);
    else value = el.value;
    state.settings[key] = value;
    markSettingsDirty(key);
  }

  function handleWebhookChange(el) {
    const key = el.dataset.webhook;
    if (!key) return;
    if (!state.settings.webhook) state.settings.webhook = { ...DEFAULT_SETTINGS.webhook };
    state.settings.webhook[key] = el.type === "checkbox" ? el.checked : el.value;
    if (key === "type") $("#webhookSecretField").hidden = el.value !== "dingtalk";
    const on = Boolean(state.settings.webhook.enabled && state.settings.webhook.url);
    const pill = $("#webhookStatusPill");
    if (pill) {
      pill.textContent = on ? "已启用" : "未启用";
      pill.classList.toggle("is-on", on);
    }
    saveState();
    showToast("消息通道已保存", state.settings.webhook.enabled && !state.settings.webhook.url ? "还需要填入 Webhook 地址才能发送。" : "设置会立即生效。", "default", 3400);
  }

  async function testNotification(channel = "native") {
    if (!serverMode) {
      if (channel === "browser") {
        const granted = await requestNotificationPermission();
        if (granted) {
          await showBrowserNotification("日序 · 测试提醒", "提醒通道正常，到点我会来叫你。", null);
          showToast("测试提醒已发送", "如果看到系统通知，说明通道正常。", "success");
        }
        return;
      }
      const granted = await requestNotificationPermission();
      if (granted) {
        await showBrowserNotification("日序 · 测试提醒", "提醒通道正常，到点我会来叫你。", null);
        playChime();
        showToast("测试提醒已发送", "浏览器通知通道正常。", "success");
      }
      return;
    }
    const button = channel === "webhook" ? $("#testWebhookBtn") : $("#testNotifyBtn");
    setButtonBusy(button, true, "发送中…");
    try {
      const data = await api("/api/notifications/test", {
        method: "POST",
        body: JSON.stringify({ channel: channel === "webhook" ? "webhook" : "windows" })
      });
      if (data.ok) showToast("测试提醒已发送", channel === "webhook" ? "去手机看看有没有收到消息。" : "右下角应该会出现一条 Windows 通知。", "success");
      else showToast("发送失败", data.result?.reason || "检查一下通知设置或 Webhook 地址。", "warn", 8000);
      await pollServerEvents();
    } catch (error) {
      showToast("发送失败", String(error.message || error), "warn");
    } finally {
      setButtonBusy(button, false);
    }
  }

  // ---------------------------------------------------------------------------
  // data actions

  function exportData() {
    const payload = {
      app: "DayFlow",
      exportedAt: new Date().toISOString(),
      state
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `dayflow-backup-${todayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast("备份已导出", "JSON 文件保存在你的下载文件夹里。", "success");
  }

  async function importData(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const imported = parsed.state || parsed;
      const next = normalizeState(imported);
      if (!next.tasks.length && !next.settings) throw new Error("没有可导入的数据");
      const confirmed = await askConfirm("导入这份备份？", `会覆盖当前的 ${state.tasks.length} 个任务和提醒设置。`, "导入");
      if (!confirmed) return;
      state = next;
      autoPlan();
      saveState();
      renderAll();
      showToast("备份已导入", "任务和行程已经恢复。", "success");
    } catch (error) {
      showToast("导入失败", "请选择日序导出的 JSON 备份文件。", "warn");
    }
  }

  async function resetAll() {
    const confirmed = await askConfirm("清空所有数据？", "任务、行程、提醒记录和设置都会恢复初始状态。这个操作不能撤销。", "清空数据");
    if (!confirmed) return;
    const fresh = defaultState();
    fresh.meta.seeded = true;
    fresh.meta.demo = false;
    fresh.meta.createdAt = new Date().toISOString();
    state = fresh;
    autoPlan();
    saveState();
    renderAll();
    navigate("today");
    showToast("已经清空", "可以从一件小事重新开始。", "success");
  }

  async function clearDemo() {
    state.tasks = state.tasks.filter((task) => !task.demo);
    state.meta.demo = false;
    autoPlan();
    saveState();
    renderAll();
    showToast("示例已清空", "现在，这里只属于你的安排。", "success");
  }

  async function clearHistory() {
    if (serverMode) {
      try {
        await api("/api/notifications/clear", { method: "POST", body: "{}" });
        serverEvents = [];
        showToast("提醒记录已清空", "接下来的提醒还会继续。", "success");
      } catch {
        showToast("清空失败", "本地助理没有响应。", "warn");
      }
    } else {
      state.meta.events = [];
      saveState();
      showToast("提醒记录已清空", "接下来的提醒还会继续。", "success");
    }
    if (currentView === "reminders") renderReminders();
    renderBell();
  }

  async function toggleAutostart(enabled) {
    if (!serverMode) {
      showToast("需要本地助理", "先运行 start.bat，再设置开机自启。", "warn");
      $("#autostartToggle").checked = false;
      return;
    }
    try {
      const data = await api("/api/autostart", { method: "POST", body: JSON.stringify({ enabled }) });
      if (data.ok) showToast(enabled ? "已设置开机自启" : "已关闭开机自启", enabled ? "下次登录 Windows 后自动在后台运行。" : "下次不会自动启动。", "success");
      serverMeta = await api("/api/meta");
      renderSettings();
    } catch {
      $("#autostartToggle").checked = !enabled;
      showToast("设置失败", "请检查本地助理是否还在运行。", "warn");
    }
  }

  async function shutdownServer() {
    const confirmed = await askConfirm("停止本地助理？", "停止后，关掉浏览器就不会再收到提醒。重新运行 start.bat 可以恢复。", "停止");
    if (!confirmed) return;
    try {
      await api("/api/shutdown", { method: "POST", body: "{}" });
      serverMode = false;
      renderServerStatus();
      showToast("本地助理已停止", "页面还可以查看，但后台提醒已经暂停。", "warn", 9000);
      if (currentView === "settings") renderSettings();
    } catch {
      showToast("停止失败", "助理可能已经不在运行了。", "warn");
    }
  }

  // ---------------------------------------------------------------------------
  // event bindings

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const viewButton = event.target.closest("[data-view]");
      if (viewButton) {
        event.preventDefault();
        navigate(viewButton.dataset.view);
        return;
      }

      const addButton = event.target.closest("[data-add-task], [data-add-day]");
      if (addButton) {
        event.preventDefault();
        if (addButton.hasAttribute("data-add-day")) {
          openTaskModal({ mode: "fixed", date: dayDate, startTime: "09:00" });
        } else {
          openTaskModal();
        }
        return;
      }

      const taskOpen = event.target.closest("[data-task-open]");
      if (taskOpen) {
        event.preventDefault();
        openTaskModal({ taskId: taskOpen.dataset.taskOpen });
        return;
      }

      const toggle = event.target.closest("[data-task-toggle]");
      if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        toggleTask(toggle.dataset.taskToggle);
        return;
      }

      const glance = event.target.closest("[data-glance-day]");
      if (glance) {
        dayDate = glance.dataset.glanceDay;
        navigate("today");
        return;
      }

      const weekDay = event.target.closest("[data-week-day]");
      if (weekDay) {
        dayDate = weekDay.dataset.weekDay;
        navigate("today");
        return;
      }

      const timelineTask = event.target.closest(".timeline-block[data-task-id], .week-event[data-task-id]");
      if (timelineTask) {
        openTaskModal({ taskId: timelineTask.dataset.taskId });
        return;
      }

      const previewEdit = event.target.closest("[data-preview-edit]");
      if (previewEdit) {
        const item = previewEdit.closest(".preview-item");
        item.classList.toggle("is-editing");
        if (item.classList.contains("is-editing")) {
          const mode = $("[data-draft-mode]", item);
          const when = $("[data-draft-when]", item);
          if (mode?.value === "fixed" && when && !when.value) {
            when.value = `${todayKey()}T09:00`;
          }
        }
        return;
      }

      const previewRemove = event.target.closest("[data-preview-remove]");
      if (previewRemove) {
        syncDraftsFromPreview();
        const index = Number(previewRemove.dataset.previewRemove);
        parsedDrafts.splice(index, 1);
        renderParsePreview();
        return;
      }
      if (event.target.closest("[data-preview-confirm]")) {
        if (parsedActions.length) {
          applyParsedActions();
          return;
        }
        syncDraftsFromPreview();
        commitDrafts(parsedDrafts.slice());
        return;
      }
      if (event.target.closest("[data-preview-cancel]")) {
        parsedDrafts = [];
        parsedActions = [];
        managementReply = "";
        $("#parsePreview").hidden = true;
        return;
      }

      const channelAction = event.target.closest("[data-channel-test]");
      if (channelAction) {
        testNotification(channelAction.dataset.channelTest);
        return;
      }
      if (event.target.closest("[data-enable-browser]")) {
        requestNotificationPermission().then(() => renderReminders());
        return;
      }
      if (event.target.closest("[data-show-start]")) {
        showToast("启动本地助理", "双击 dayflow 文件夹里的 start.bat；保持后台运行，关掉浏览器也能收到提醒。", "default", 12000);
        return;
      }

      if (!event.target.closest(".bell-wrap")) {
        $("#bellPopover").hidden = true;
        $("#bellBtn").setAttribute("aria-expanded", "false");
      }
    });

    $("#mainNav").addEventListener("click", () => {});
    $("#userChip").addEventListener("click", () => navigate("settings"));

    $("#topAddBtn").addEventListener("click", () => openTaskModal());
    $("#mobileAddBtn").addEventListener("click", () => openTaskModal());
    $("#planAddBtn").addEventListener("click", () => openTaskModal());
    $("#taskAddBtn").addEventListener("click", () => openTaskModal());

    $("#captureForm").addEventListener("submit", (event) => {
      event.preventDefault();
      handleCaptureSubmit();
    });
    $$("#captureMode button").forEach((button) => {
      button.addEventListener("click", () => setCaptureMode(button.dataset.captureMode));
    });
    $("#voiceBtn")?.addEventListener("click", toggleVoiceInput);
    $("#captureInput").addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        handleCaptureSubmit();
      }
    });
    $("#parsePreview").addEventListener("change", (event) => {
      const item = event.target.closest(".preview-item");
      if (!item) return;
      if (event.target.matches("[data-draft-mode]")) {
        const when = $("[data-draft-when]", item);
        const label = when?.closest(".preview-field")?.querySelector("span");
        if (label) label.textContent = event.target.value === "fixed" ? "开始" : "截止（可空）";
        if (event.target.value === "fixed" && when && !when.value) when.value = `${todayKey()}T09:00`;
      }
    });
    $$("[data-example]").forEach((button) => {
      button.addEventListener("click", () => {
        $("#captureInput").value = button.dataset.example;
        $("#captureInput").focus();
      });
    });

    $("#prevDayBtn").addEventListener("click", () => {
      dayDate = addDaysKey(dayDate, -1);
      renderToday();
    });
    $("#nextDayBtn").addEventListener("click", () => {
      dayDate = addDaysKey(dayDate, 1);
      renderToday();
    });
    $("#backTodayBtn").addEventListener("click", () => {
      dayDate = todayKey();
      renderToday();
    });
    $("#todayTimeline").addEventListener("dblclick", (event) => {
      if (event.target.closest(".timeline-block")) return;
      const list = tasksForDay(dayDate);
      const range = timelineRange(list);
      const rect = event.currentTarget.getBoundingClientRect();
      const y = event.clientY - rect.top;
      const minutes = range.start + (y / HOUR_HEIGHT_DAY) * 60;
      const snapped = clamp(Math.round(minutes / 30) * 30, 0, 23 * 60 + 30);
      openTaskModal({ mode: "fixed", date: dayDate, startTime: timeFromMinutes(snapped) });
    });
    $("#todayTimeline").addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        const block = event.target.closest(".timeline-block[data-task-id]");
        if (block) {
          event.preventDefault();
          openTaskModal({ taskId: block.dataset.taskId });
        }
      }
    });

    $("#prevWeekBtn").addEventListener("click", () => {
      weekStartKey = addDaysKey(weekStartKey, -7);
      renderWeek();
    });
    $("#nextWeekBtn").addEventListener("click", () => {
      weekStartKey = addDaysKey(weekStartKey, 7);
      renderWeek();
    });
    $("#thisWeekBtn").addEventListener("click", () => {
      weekStartKey = dateKey(startOfWeek(new Date()));
      renderWeek();
    });
    $("#replanBtn").addEventListener("click", () => {
      const result = autoPlan();
      saveState();
      renderAll();
      showToast("重新排好了", result.unscheduled ? `${result.scheduled} 件已安排，${result.unscheduled} 件排不下。` : `${result.scheduled} 件任务已经放进本周的空档。`, result.unscheduled ? "warn" : "success");
    });

    $("#taskTabs").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-status]");
      if (!button) return;
      taskFilter.status = button.dataset.status;
      renderTasks();
    });
    $("#categoryFilter").addEventListener("change", (event) => {
      taskFilter.category = event.target.value;
      renderTasks();
    });
    $("#taskSearch").addEventListener("input", (event) => {
      taskFilter.query = event.target.value.trim();
      renderTasks();
    });

    state = state || defaultState();
    $$("[data-quick-setting]").forEach((el) => {
      el.addEventListener("change", () => {
        state.settings[el.dataset.quickSetting] = el.checked;
        saveState();
        if (currentView === "reminders") renderReminders();
        showToast("提醒设置已更新", "新的设置会从下一分钟开始生效。", "success", 3000);
      });
    });
    $("#quickLead").addEventListener("change", (event) => {
      state.settings.defaultLead = Number(event.target.value);
      saveState();
      renderBell();
      showToast("默认提前量已更新", `之后会提前 ${event.target.value} 分钟提醒。`, "success", 3000);
    });

    $("#testNotifyBtn").addEventListener("click", () => testNotification("native"));
    $("#clearHistoryBtn").addEventListener("click", clearHistory);
    $("#clearDemoBtn").addEventListener("click", clearDemo);
    $("#dismissDemoBtn").addEventListener("click", () => {
      state.meta.demoBannerDismissed = true;
      saveState();
      $("#demoBanner").hidden = true;
    });

    $("#bellBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      const popover = $("#bellPopover");
      popover.hidden = !popover.hidden;
      $("#bellBtn").setAttribute("aria-expanded", String(!popover.hidden));
      renderBell();
    });

    $("#nextAction").addEventListener("click", (event) => {
      event.preventDefault();
      const taskId = event.currentTarget.dataset.taskId;
      if (taskId) openTaskModal({ taskId });
    });

    $("#taskForm").addEventListener("submit", saveTaskFromForm);
    $("#deleteTaskBtn").addEventListener("click", () => { if (editingTaskId) deleteTask(editingTaskId); });
    $$("[data-close-modal]").forEach((el) => el.addEventListener("click", closeTaskModal));
    $$("[data-close-confirm]").forEach((el) => el.addEventListener("click", () => closeConfirm(false)));
    $("#confirmCancel").addEventListener("click", () => closeConfirm(false));
    $("#confirmOk").addEventListener("click", () => closeConfirm(true));

    $$("#modeSwitch button").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    });
    $("#categoryPicker").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-category]");
      if (button) setCategory(button.dataset.category);
    });
    $("#priorityPicker").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-priority]");
      if (button) setPriority(button.dataset.priority);
    });

    const settingsView = $("#view-settings");
    settingsView.addEventListener("change", (event) => {
      const el = event.target;
      if (el.dataset.setting) handleSettingChange(el);
      else if (el.dataset.webhook) handleWebhookChange(el);
    });
    $("#autostartToggle").addEventListener("change", (event) => toggleAutostart(event.target.checked));
    $("#testWebhookBtn").addEventListener("click", () => testNotification("webhook"));
    $("#generateNtfyBtn").addEventListener("click", () => {
      const topic = `dayflow-${Math.random().toString(36).slice(2, 10)}`;
      state.settings.webhook.enabled = true;
      state.settings.webhook.type = "ntfy";
      state.settings.webhook.url = `https://ntfy.sh/${topic}`;
      saveState();
      renderSettings();
      showToast("已生成 ntfy 主题", `在手机安装 ntfy，订阅主题「${topic}」，然后点「发送测试消息」。`, "success", 12000);
    });
    $("#copyPhoneUrl").addEventListener("click", async () => {
      const text = $("#phoneUrl")?.textContent?.trim() || "";
      if (!text || text.includes("未开启") || text.includes("未运行")) {
        showToast("还没有手机访问地址", "双击 start-phone.bat 启动手机访问模式后再试。", "warn");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        showToast("地址已复制", "在手机和电脑连同一个 Wi-Fi 后，用手机浏览器打开它。", "success");
      } catch {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
        showToast("地址已复制", text, "success");
      }
    });
    $("#openWebhookHelpBtn").addEventListener("click", () => {
      showToast("手机消息怎么配置", "最省事：点「生成 ntfy 主题」，手机装 ntfy App 后订阅这个主题。企业微信/飞书/钉钉则复制群机器人 Webhook 地址。", "default", 14000);
    });
    $("#aiApiKey")?.addEventListener("change", (event) => {
      const value = event.target.value.trim();
      if (!value) return;
      localStorage.setItem(AI_KEY_STORAGE, value);
      localStorage.setItem(AI_ENABLED_STORAGE, "true");
      renderAISettings();
      showToast("AI Key 已保存", "只保存在这台浏览器。现在可以在首页用自然语言安排日程了。", "success");
    });
    $("#aiModel")?.addEventListener("change", (event) => {
      localStorage.setItem(AI_MODEL_STORAGE, event.target.value);
      showToast("AI 模型已切换", event.target.value, "success", 3000);
    });
    $("#aiEnabled")?.addEventListener("change", (event) => {
      localStorage.setItem(AI_ENABLED_STORAGE, event.target.checked ? "true" : "false");
      updateAITag();
      renderAISettings();
    });
    $("#clearAIKey")?.addEventListener("click", () => {
      localStorage.removeItem(AI_KEY_STORAGE);
      localStorage.removeItem(AI_ENABLED_STORAGE);
      renderAISettings();
      showToast("已清除 AI Key", "首页会回退到本地规则解析。", "default");
    });
    $("#testAI")?.addEventListener("click", async () => {
      if (!aiKey()) {
        showToast("还没有配置 AI Key", "先在 Settings 里填入 DeepSeek API Key。", "warn");
        return;
      }
      const button = $("#testAI");
      setButtonBusy(button, true, "测试中…");
      try {
        const drafts = await parseWithAI("明天下午3点和导师开会，地点在图书馆");
        parsedDrafts = drafts;
        renderParsePreview();
        showToast("AI 解析已连通", `测试句子解析出 ${drafts.length} 件事，已在首页预览。`, "success", 8000);
      } catch (error) {
        showToast("AI 测试失败", String(error.message || error), "warn", 10000);
      } finally {
        setButtonBusy(button, false);
      }
    });
    $("#exportBtn").addEventListener("click", exportData);
    $("#importBtn").addEventListener("click", () => $("#importFile").click());
    $("#cloudImportBtn")?.addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", (event) => {
      importData(event.target.files?.[0]);
      event.target.value = "";
    });
    $("#resetBtn").addEventListener("click", resetAll);
    $("#shutdownBtn").addEventListener("click", shutdownServer);
    $("#restartHintBtn").addEventListener("click", () => {
      showToast("启动与停止", "启动：双击 start.bat。停止：双击 stop.bat，或在设置里点「停止本地助理」。", "default", 12000);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!$("#confirmModal").hidden) closeConfirm(false);
        else if (!$("#taskModal").hidden) closeTaskModal();
        else $("#bellPopover").hidden = true;
      }
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
      if (!typing && event.key.toLowerCase() === "n" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        openTaskModal();
      }
      if (!typing && event.key === "/" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        navigate("today");
        setTimeout(() => $("#captureInput").focus(), 80);
      }
    });

    window.addEventListener("hashchange", () => {
      const view = location.hash.replace("#", "");
      if (VIEW_TITLES[view] && view !== currentView) navigate(view, { updateHash: false });
    });
  }

  // ---------------------------------------------------------------------------
  // init

  async function bootstrap() {
    if (new URLSearchParams(location.search).has("skipboot")) {
      $("#bootScreen")?.remove();
    }
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        if (data.state) {
          state = normalizeState(data.state);
          serverMode = true;
        }
      }
    } catch {
      serverMode = false;
    }

    if (!state) state = loadLocalState();
    if (!state) state = defaultState();
    state = normalizeState(state);

    if (!state.meta.seeded) {
      seedDemo();
      state.meta.seeded = true;
    }

    const hasUnplanned = state.tasks.some((task) => !task.fixed && !task.done && !task.start);
    const hasStaleAuto = state.tasks.some((task) => {
      if (task.done || task.fixed || !task.start) return false;
      const end = parseDateTime(task.end) || parseDateTime(task.start);
      return end && end < new Date();
    });
    if (!state.meta.lastPlanAt || hasUnplanned || hasStaleAuto) {
      autoPlan();
      setTimeout(() => saveState(), 50);
    }

    bindEvents();
    const hashView = location.hash.replace("#", "");
    currentView = VIEW_TITLES[hashView] ? hashView : "today";
    dayDate = todayKey();
    weekStartKey = dateKey(startOfWeek(new Date()));
    navigate(currentView, { updateHash: false });
    renderAll();

    if (serverMode) {
      refreshServerMeta();
      pollServerEvents(true);
      pollTimer = setInterval(pollServerEvents, 8000);
    } else {
      cacheLocalState();
      setTimeout(checkLocalReminders, 2500);
      localTimer = setInterval(checkLocalReminders, 15000);
    }

    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("sw.js?v=20261113c").catch(() => {});
    }

    clockTimer = setInterval(() => {
      const now = new Date();
      $("#liveClock").textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      if (currentView === "today" && dayDate === todayKey()) {
        const dayTasks = tasksForDay(dayDate);
        renderNextCard(dayTasks, dayDate);
        const range = timelineRange(dayTasks);
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const line = $(".timeline-now");
        if (line && nowMinutes >= range.start && nowMinutes <= range.end) {
          line.style.top = `${((nowMinutes - range.start) / 60) * HOUR_HEIGHT_DAY}px`;
        }
      }
    }, 20000);
    const now = new Date();
    $("#liveClock").textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

    const captureParam = new URLSearchParams(location.search).get("capture");
    if (captureParam) {
      setTimeout(() => {
        $("#captureInput").value = captureParam;
        handleCaptureSubmit();
      }, 500);
    }

    if (state.meta.demo) {
      setTimeout(() => saveState(), 600);
    }

    setTimeout(() => {
      const boot = $("#bootScreen");
      if (!boot) return;
      boot.classList.add("is-hidden");
      setTimeout(() => boot.remove(), 500);
    }, 380);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();


