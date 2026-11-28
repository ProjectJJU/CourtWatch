const cfgApi = window.CourtConfig;
const checkApi = window.CourtCheck;
const NTFY_SERVER = "https://ntfy.sh";
const OWNER_EMAIL = "jinid231@gmail.com";
const fields = ["topic", "ntfy-token"];
const state = {
  config: null,
  status: null,
  selectedGroup: 0,
  editingGroupInfo: false,
  editingGroupWatch: false,
  editingGeneral: false,
  statusFold: {
    alarm: true,
    open: true,
    history: false,
    errors: false,
  },
};
let auth = null;
let db = null;

const message = document.querySelector("#message");

function say(text) {
  message.textContent = text || "";
}

function sayAccount(text) {
  const box = document.querySelector("#account-message");
  if (box) box.textContent = text || "";
}

function sayTools(text) {
  const box = document.querySelector("#tools-message");
  if (box) box.textContent = text || "";
}

function storageKey(name) {
  return `courtwatch.${name}`;
}

function loadLocal() {
  fields.forEach((name) => {
    const saved = localStorage.getItem(storageKey(name));
    if (saved) document.querySelector("#" + name).value = saved;
  });
}

function saveLocal() {
  fields.forEach((name) => {
    localStorage.setItem(storageKey(name), document.querySelector("#" + name).value.trim());
  });
}

function firebaseReady() {
  const cfg = window.FIREBASE_CONFIG || {};
  return Boolean(cfg.apiKey && cfg.authDomain && cfg.projectId && cfg.appId);
}

function firebaseMessage(error) {
  const code = error && error.code;
  if (code === "permission-denied") return "이 계정은 설정을 고칠 수 없습니다.";
  if (code === "auth/invalid-email") return "이메일 형식이 올바르지 않습니다.";
  if (code === "auth/user-not-found" || code === "auth/wrong-password" || code === "auth/invalid-credential") {
    return "이메일 또는 비밀번호가 맞지 않습니다.";
  }
  if (code === "auth/too-many-requests") return "로그인을 너무 많이 시도했습니다. 잠시 후 다시 하세요.";
  return (error && error.message) || "Firebase 요청에 실패했습니다.";
}

function showAccount(user) {
  const account = document.querySelector("#account");
  const signInForm = document.querySelector("#sign-in-form");
  const signedInBox = document.querySelector("#signed-in-box");
  const accountDot = document.querySelector("#account-dot");
  account.textContent = user && user.email ? user.email : "";
  signInForm.hidden = Boolean(user);
  signedInBox.hidden = !user;
  accountDot.hidden = !user;
  if (user) resetEmailEditor();
}

async function loadDocs() {
  const configSnap = await db.collection("courtwatch").doc("config").get();
  if (!configSnap.exists) {
    state.config = null;
    state.status = null;
    render();
    say("아직 설정이 없습니다. 검사가 한 번 돌면 만들어집니다.");
    return;
  }
  state.config = configSnap.data() || {};
  state.config.presets = state.config.presets || [];
  state.config.sleep = state.config.sleep || { start: "02:00", end: "02:00" };
  state.config = cfgApi.scrubClosedSlots(state.config);
  syncGroupsFromWatches();
  const statusSnap = await db.collection("courtwatch").doc("state").get();
  state.status = statusSnap.exists ? statusSnap.data() : null;
  if (state.selectedGroup >= (state.config.booking_groups || []).length) state.selectedGroup = 0;
  closeEditors();
  render();
  say("");
}

function closeEditors() {
  state.editingGroupInfo = false;
  state.editingGroupWatch = false;
  state.editingGeneral = false;
}

function syncGroupsFromWatches() {
  (state.config.booking_groups || []).forEach((group) => {
    const first = (state.config.watches || []).find((watch) =>
      (group.courts || []).map(Number).includes(Number(watch.id))
    );
    if (!group.open && first) group.open = first.open || "06:00";
    if (!group.close && first) group.close = first.close || "22:00";
  });
}

function selectedGroup() {
  return (state.config.booking_groups || [])[state.selectedGroup] || null;
}

function watchesInGroup(group) {
  const ids = new Set((group.courts || []).map(Number));
  return (state.config.watches || []).filter((watch) => ids.has(Number(watch.id)));
}

function groupWeekdaySlots(group) {
  const watches = watchesInGroup(group);
  return watches[0] ? [...(watches[0].weekday_slots || [])] : [];
}

function groupSaturdaySlots(group) {
  const watches = watchesInGroup(group);
  return watches[0] ? [...(watches[0].saturday_slots || [])] : [];
}

function groupSundaySlots(group) {
  const watches = watchesInGroup(group);
  const slots = watches[0] ? [...(watches[0].sunday_slots || [])] : [];
  const closed = cfgApi.closedSlotsFor(group, 6);
  return slots.filter((slot) => !closed.has(slot));
}

function groupWeekendSlots(group) {
  const watches = watchesInGroup(group);
  return watches[0] ? [...(watches[0].weekend_slots || [])] : [];
}

function closedDayNote(group, weekday) {
  const slots = [...cfgApi.closedSlotsFor(group, weekday)];
  if (!slots.length) return "";
  const text = slots.map((slot) => String(slot).replace("-", "–")).join(", ");
  return `${cfgApi.WEEKDAYS[weekday]}요일 ${text}은 예약이 없습니다.`;
}

function applyGroupSlots(group, kind, slots) {
  const sorted = [...slots].sort();
  watchesInGroup(group).forEach((watch) => {
    if (kind === "weekday") watch.weekday_slots = [...sorted];
    else if (kind === "saturday") watch.saturday_slots = [...sorted];
    else if (kind === "sunday") watch.sunday_slots = [...sorted];
    else {
      watch.saturday_slots = [...sorted];
      watch.sunday_slots = [...sorted];
    }
    Object.assign(watch, cfgApi.normalizeWatch(watch));
  });
  state.config = cfgApi.scrubClosedSlots(state.config);
}

function groupExtras(group) {
  const watches = watchesInGroup(group);
  return watches[0] ? JSON.parse(JSON.stringify(watches[0].extras || [])) : [];
}

function applyGroupExtras(group, extras) {
  const watches = watchesInGroup(group);
  if (!watches.length) {
    say("먼저 코트를 추가하세요.");
    return false;
  }
  const normalized = extras.map(cfgApi.normalizeExtra);
  watches.forEach((watch) => {
    watch.extras = JSON.parse(JSON.stringify(normalized));
    Object.assign(watch, cfgApi.normalizeWatch(watch));
  });
  state.config = cfgApi.scrubClosedSlots(state.config);
  return true;
}

function applyGroupHours(group) {
  watchesInGroup(group).forEach((watch) => {
    watch.open = group.open || "06:00";
    watch.close = group.close || "22:00";
  });
}

function describeExtra(extra) {
  const days = cfgApi.formatWeekdays(extra.weekdays || []);
  const dates = (extra.dates || []).join(", ");
  const when = [days !== "없음" && days ? days : "", dates].filter(Boolean).join(" · ") || "날 미정";
  const slots = (extra.slots || []).join(", ") || "시간 미정";
  const mode = extra.replace ? "대신" : "추가";
  return `${when} · ${slots} (${mode})`;
}

function loggedIn() {
  return Boolean(auth && auth.currentUser);
}

async function signedIn(user) {
  showAccount(user);
  await loadDocs();
}

function loginEmail() {
  return document.querySelector("#email").value.trim() || OWNER_EMAIL;
}

function resetEmailEditor() {
  const input = document.querySelector("#email");
  const edit = document.querySelector("#email-edit-button");
  if (!input) return;
  input.value = OWNER_EMAIL;
  input.readOnly = true;
  if (edit) edit.setAttribute("aria-pressed", "false");
}

async function signIn() {
  saveLocal();
  if (!auth) {
    sayAccount("Firebase가 설정되지 않았습니다");
    return;
  }
  const email = loginEmail();
  const password = document.querySelector("#password").value;
  if (!email) {
    sayAccount("이메일을 입력하세요.");
    return;
  }
  if (!password) {
    sayAccount("비밀번호를 입력하세요.");
    return;
  }
  await auth.signInWithEmailAndPassword(email, password);
  document.querySelector("#password").value = "";
  resetEmailEditor();
  sayAccount("");
  say("로그인했습니다.");
}

async function saveRepo() {
  saveLocal();
  if (!auth || !auth.currentUser || !state.config) {
    say("먼저 로그인하세요.");
    return;
  }
  applyGroupHoursToAll();
  const payload = cfgApi.prepareConfigForSave(state.config);
  const missingRelease = (payload.booking_groups || []).some(
    (group) => !Object.prototype.hasOwnProperty.call(group, "release")
  );
  if (missingRelease) {
    say("저장 준비에 실패했습니다. 페이지를 새로고침한 뒤 다시 저장하세요.");
    return;
  }
  await db.collection("courtwatch").doc("config").set(payload);
  const saved = await db.collection("courtwatch").doc("config").get();
  const groups = ((saved.data() || {}).booking_groups || []).map((group) => ({
    id: group.id,
    release: group.release,
  }));
  const lost = groups.some((group) => group.release === undefined);
  if (lost) {
    say("저장됐지만 release가 비었습니다. 다시 저장하거나 콘솔로 확인하세요.");
    console.warn("saved booking_groups release", groups);
  }
  state.config = cfgApi.scrubClosedSlots(payload);
  closeEditors();
  render();
  say(lost ? "저장 확인에 실패했습니다." : "저장했습니다. 다음 검사부터 적용됩니다.");
}

function applyGroupHoursToAll() {
  (state.config.booking_groups || []).forEach((group) => applyGroupHours(group));
}

async function testNtfy() {
  saveLocal();
  const topic = document.querySelector("#topic").value.trim();
  const server = NTFY_SERVER;
  if (!topic) {
    sayTools("ntfy 토픽을 입력하세요.");
    return;
  }
  const ntfyToken = document.querySelector("#ntfy-token").value.trim();
  const headers = { "Content-Type": "application/json" };
  if (ntfyToken) headers.Authorization = `Bearer ${ntfyToken}`;
  const response = await fetch(server, {
    method: "POST",
    headers,
    body: JSON.stringify({
      topic,
      title: "연결 확인",
      message: "연결 확인",
      priority: 3,
      tags: ["tennis"],
    }),
  });
  sayTools(response.ok ? "테스트 알림을 보냈습니다." : "테스트 알림을 보내지 못했습니다.");
}

function plain(value) {
  return String(value || "")
    .replace(/(?:\[[^\]]+\]\([^)]+\)|<\s*https?:\/\/[^>]+>|https?:\/\/\S+|www\.\S+|javascript:\S+|data:\S+)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function seoulTodayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function seoulNowHm() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

function renderCheckList(keys) {
  const list = document.createElement("ul");
  list.className = "status-list";
  checkApi.describe(state.config, keys).forEach((item) => {
    const row = document.createElement("li");
    row.textContent = `${plain(item.name)}  ${item.day} (${item.weekday})  ${item.slot}`;
    list.append(row);
  });
  return list;
}

function renderCheckLine(text) {
  const line = document.createElement("p");
  line.className = "status-line";
  line.textContent = text;
  return line;
}

function renderCheckResult(result) {
  const box = document.querySelector("#check-result");
  box.replaceChildren();
  const alarmLabel = document.createElement("p");
  alarmLabel.className = "group-label";
  alarmLabel.textContent = "알람";
  box.append(alarmLabel);
  if (!result.alarm.comparable) {
    box.append(renderCheckLine("마지막 검사 기록이 없어 알람은 비교할 수 없습니다."));
  } else if (!result.alarm.keys.length) {
    box.append(renderCheckLine("새로 빈 시간이 없습니다."));
  } else {
    box.append(renderCheckList(result.alarm.keys));
  }
  const checkLabel = document.createElement("p");
  checkLabel.className = "group-label";
  checkLabel.textContent = "체크";
  box.append(checkLabel);
  if (!result.open.length) {
    box.append(renderCheckLine("지금 빈 시간이 없습니다."));
  } else {
    box.append(renderCheckList(result.open));
  }
}

async function runCheck(word) {
  if (!checkApi.isCheckCommand(word)) {
    sayTools("체크라고 입력하세요.");
    return;
  }
  if (!state.config) {
    sayTools("아직 설정이 없습니다.");
    return;
  }
  const button = document.querySelector("#check-form button");
  button.disabled = true;
  sayTools("확인 중입니다.");
  try {
    const result = await checkApi.loadPreview(
      state.config,
      state.status,
      seoulTodayIso(),
      undefined,
      seoulNowHm()
    );
    renderCheckResult(result);
    sayTools("");
  } catch (error) {
    document.querySelector("#check-result").replaceChildren();
    sayTools(error && error.message ? error.message : "예약 정보를 읽지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

function statusAlertKeys(current) {
  const open = current.open_now || [];
  const keys = [];
  const seen = new Set();
  const push = (list) => {
    (list || []).forEach((key) => {
      if (!key || seen.has(key)) return;
      seen.add(key);
      keys.push(key);
    });
  };
  if (Object.prototype.hasOwnProperty.call(current, "last_alerts")) {
    push(current.last_alerts);
  } else {
    push(checkApi.alarmKeys(current, open).keys);
  }
  push((current.pending || []).filter((key) => open.includes(key)));
  return keys;
}

function formatIsoDay(iso) {
  const parts = String(iso || "").split("-");
  if (parts.length !== 3) return iso || "";
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!month || !day) return iso;
  return `${month}월 ${day}일`;
}

function renderSlotPills(slots, emptyText) {
  const row = document.createElement("div");
  row.className = "slot-pills";
  const list = slots || [];
  if (!list.length) {
    const empty = document.createElement("span");
    empty.className = "slot-empty";
    empty.textContent = emptyText || "없음";
    row.append(empty);
    return row;
  }
  list.forEach((slot) => {
    const pill = document.createElement("span");
    pill.className = "slot-pill";
    pill.textContent = String(slot).replace("-", "–");
    row.append(pill);
  });
  return row;
}

function renderWatchSummary(group) {
  const wrap = document.createElement("div");
  wrap.className = "watch-summary";

  appendSlotBlock(wrap, "평일", groupWeekdaySlots(group), "");
  if (cfgApi.weekendSplit(group)) {
    appendSlotBlock(wrap, "토요일", groupSaturdaySlots(group), closedDayNote(group, 5));
    appendSlotBlock(wrap, "일요일", groupSundaySlots(group), closedDayNote(group, 6));
  } else {
    appendSlotBlock(wrap, "주말", groupWeekendSlots(group), "");
  }

  const extras = groupExtras(group);
  if (extras.length) {
    const extrasBlock = document.createElement("div");
    extrasBlock.className = "watch-block";
    const extrasTitle = document.createElement("p");
    extrasTitle.className = "group-label";
    extrasTitle.textContent = `추가 감시 ${extras.length}개`;
    extrasBlock.append(extrasTitle);
    const list = document.createElement("div");
    list.className = "extra-summary-list";
    extras.forEach((extra, index) => {
      const card = document.createElement("div");
      card.className = "extra-summary";
      const name = document.createElement("strong");
      name.textContent = plain(extra.label) || `추가 ${index + 1}`;
      const detail = document.createElement("p");
      detail.textContent = describeExtra(extra);
      card.append(name, detail);
      card.append(renderSlotPills(extra.slots || [], "시간 미정"));
      list.append(card);
    });
    extrasBlock.append(list);
    wrap.append(extrasBlock);
  }
  return wrap;
}

function bookableKeys(keys) {
  const groups = (state.config && state.config.booking_groups) || [];
  return (keys || []).filter((key) => {
    const parts = String(key).split("|");
    if (parts.length < 3) return true;
    const courtId = parts[0];
    const day = parts[1];
    const slot = parts.slice(2).join("|");
    const group = groups.find((item) => (item.courts || []).map(String).includes(String(courtId)));
    if (!group) return true;
    return !cfgApi.closedSlotsFor(group, checkApi.weekdayIndex(day)).has(slot);
  });
}

function renderKeyList(keys) {
  const list = document.createElement("ul");
  list.className = "status-list key-list";
  checkApi.describe(state.config || {}, bookableKeys(keys)).forEach((item) => {
    const row = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = plain(item.name) || item.id;
    const meta = document.createElement("span");
    meta.textContent = `${formatIsoDay(item.day)} (${item.weekday})  ${String(item.slot).replace("-", "–")}`;
    row.append(name, meta);
    list.append(row);
  });
  return list;
}

function foldSection(key, title, badge, buildBody) {
  const open = Boolean(state.statusFold[key]);
  const section = document.createElement("section");
  section.className = "fold" + (open ? " open" : "");
  const head = document.createElement("button");
  head.type = "button";
  head.className = "fold-head";
  head.setAttribute("aria-expanded", open ? "true" : "false");
  const label = document.createElement("span");
  label.className = "fold-title";
  label.textContent = title;
  const right = document.createElement("span");
  right.className = "fold-right";
  if (badge) {
    const mark = document.createElement("span");
    mark.className = "fold-badge";
    mark.textContent = badge;
    right.append(mark);
  }
  const chevron = document.createElement("span");
  chevron.className = "fold-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = open ? "▾" : "▸";
  right.append(chevron);
  head.append(label, right);
  head.addEventListener("click", () => {
    state.statusFold[key] = !state.statusFold[key];
    render();
  });
  section.append(head);
  if (open) {
    const body = document.createElement("div");
    body.className = "fold-body";
    buildBody(body);
    section.append(body);
  }
  return section;
}

function renderStatus() {
  const box = document.querySelector("#status");
  box.replaceChildren();
  const current = state.status;
  if (!current) {
    box.textContent = "아직 검사 기록이 없습니다.";
    return;
  }
  const checked = document.createElement("p");
  checked.className = "status-line check-time";
  checked.textContent = `마지막 검사 ${current.last_check || "없음"}`;
  box.append(checked);
  if (current.last_error) {
    const error = document.createElement("p");
    error.className = "status-line";
    error.textContent = plain(current.last_error);
    box.append(error);
  }

  const open = bookableKeys(current.open_now || []);
  const alerts = bookableKeys(statusAlertKeys(current));
  const history = (current.alert_history || [])
    .map((item) => {
      if (!item || typeof item !== "object" || !Array.isArray(item.keys)) return null;
      const keys = bookableKeys(item.keys);
      if (!keys.length) return null;
      return { at: item.at || "", keys };
    })
    .filter(Boolean);
  const errors = [];
  const pushError = (item) => {
    if (!item || typeof item !== "object") return;
    const error = plain(item.error || "");
    if (!error) return;
    errors.push({ at: item.at || "", error });
  };
  (current.error_history || []).forEach(pushError);
  (current.alert_history || []).forEach((item) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item.keys) && item.keys.length) return;
    pushError(item);
  });

  box.append(
    foldSection("alarm", "알람 · 이번 주기", String(alerts.length), (body) => {
      if (!current.initialized) {
        body.append(renderCheckLine("첫 검사라 비교할 이전 기록이 없습니다."));
      } else if (!alerts.length) {
        body.append(renderCheckLine("이번 주기에 보낼 알람이 없습니다."));
      } else {
        body.append(renderKeyList(alerts));
      }
    })
  );

  box.append(
    foldSection("open", "빈 시간", String(open.length), (body) => {
      if (!open.length) {
        body.append(renderCheckLine("지금 빈 시간 없음"));
      } else {
        body.append(renderKeyList(open));
      }
    })
  );

  box.append(
    foldSection("history", "알람 기록", `${Math.min(history.length, 10)}/10`, (body) => {
      if (!history.length) {
        body.append(renderCheckLine("아직 저장된 알람 기록이 없습니다."));
        return;
      }
      history.slice(0, 10).forEach((entry) => {
        const card = document.createElement("div");
        card.className = "history-card";
        const when = document.createElement("p");
        when.className = "history-at";
        when.textContent = entry.at || "시각 없음";
        card.append(when);
        card.append(renderKeyList(entry.keys || []));
        body.append(card);
      });
    })
  );

  box.append(
    foldSection("errors", "에러 기록", `${Math.min(errors.length, 50)}/50`, (body) => {
      if (!errors.length) {
        body.append(renderCheckLine("아직 저장된 에러 기록이 없습니다."));
        return;
      }
      errors.slice(0, 50).forEach((entry) => {
        const card = document.createElement("div");
        card.className = "history-card error-card";
        const when = document.createElement("p");
        when.className = "history-at";
        when.textContent = entry.at || "시각 없음";
        card.append(when);
        card.append(renderCheckLine(entry.error));
        body.append(card);
      });
    })
  );
}

function seoulToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const pick = (type) => Number(parts.find((part) => part.type === type).value);
  return new Date(pick("year"), pick("month") - 1, pick("day"));
}

function addDays(day, count) {
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  next.setDate(next.getDate() + count);
  return next;
}

function formatMonthDay(day) {
  return `${day.getMonth() + 1}월 ${day.getDate()}일`;
}

function sleepLabel(sleep) {
  if (sleepIsOff(sleep)) return "없음";
  return `${sleep.start} – ${sleep.end}`;
}

function sleepIsOff(sleep) {
  return !sleep || !sleep.start || sleep.start === sleep.end;
}

function openSleepDraft() {
  const sleep = (state.config && state.config.sleep) || {};
  const off = sleepIsOff(sleep);
  state.sleepDraft = {
    mode: off ? "off" : "range",
    start: off ? "02:00" : sleep.start,
    end: off ? "06:00" : sleep.end,
  };
}

function renderGeneral() {
  const root = document.querySelector("#general-detail");
  if (!root || !state.config) return;
  root.replaceChildren();
  const config = state.config;
  const sleep = config.sleep || {};

  const head = document.createElement("div");
  head.className = "panel-head";
  const titleBox = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = "전체 알림";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "모든 코트에 같이 적용됩니다.";
  titleBox.append(title, hint);
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "ghost";
  editButton.textContent = state.editingGeneral ? "닫기" : "수정";
  editButton.addEventListener("click", () => {
    state.editingGeneral = !state.editingGeneral;
    if (state.editingGeneral) openSleepDraft();
    render();
  });
  head.append(titleBox, editButton);
  root.append(head);

  if (!state.editingGeneral) {
    const info = document.createElement("div");
    info.className = "info-grid";
    info.append(infoCard("수면", sleepLabel(sleep), true));
    root.append(info);
    return;
  }

  if (!state.sleepDraft) openSleepDraft();
  const draft = state.sleepDraft;
  const sleepLabelText = document.createElement("p");
  sleepLabelText.className = "group-label";
  sleepLabelText.textContent = "수면";
  const modeRow = document.createElement("div");
  modeRow.className = "sleep-mode";
  modeRow.append(
    chip("수면 없음", draft.mode === "off", () => {
      state.sleepDraft.mode = "off";
      state.config.sleep = { start: "00:00", end: "00:00" };
      render();
    }),
    chip("시간 지정", draft.mode === "range", () => {
      state.sleepDraft.mode = "range";
      render();
    })
  );
  root.append(sleepLabelText, modeRow);

  if (draft.mode !== "range") return;

  const timeRow = document.createElement("div");
  timeRow.className = "time-row";
  const startField = document.createElement("label");
  startField.append(document.createTextNode("수면 시작"));
  const startInput = document.createElement("input");
  startInput.type = "time";
  startInput.id = "sleep-start";
  startInput.value = draft.start || "";
  startInput.addEventListener("input", () => {
    state.sleepDraft.start = startInput.value;
  });
  startField.append(startInput);
  const endField = document.createElement("label");
  endField.append(document.createTextNode("수면 끝"));
  const endInput = document.createElement("input");
  endInput.type = "time";
  endInput.id = "sleep-end";
  endInput.value = draft.end || "";
  endInput.addEventListener("input", () => {
    state.sleepDraft.end = endInput.value;
  });
  endField.append(endInput);
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "ghost";
  apply.textContent = "적용";
  apply.addEventListener("click", () => {
    const start = startInput.value;
    const end = endInput.value;
    if (!start || !end) {
      say("수면 시작과 끝을 고르세요.");
      return;
    }
    if (start === end) {
      say("시작과 끝을 다르게 고르세요.");
      return;
    }
    state.config.sleep = { start, end };
    state.sleepDraft.start = start;
    state.sleepDraft.end = end;
    say("");
    render();
  });
  timeRow.append(startField, endField, apply);
  root.append(timeRow);
}

function chip(label, active, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.classList.toggle("active", active);
  button.addEventListener("click", onClick);
  return button;
}

function renderGroups() {
  const list = document.querySelector("#group-list");
  list.replaceChildren();
  (state.config.booking_groups || []).forEach((group, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group-item" + (index === state.selectedGroup ? " active" : "");
    const title = document.createElement("strong");
    title.textContent = plain(group.name) || "그룹";
    const detail = document.createElement("small");
    const count = (group.courts || []).length;
    detail.textContent = count ? `코트 ${count}개` : "코트 없음";
    button.append(title, detail);
    button.addEventListener("click", () => {
      state.selectedGroup = index;
      state.editingGroupInfo = false;
      state.editingGroupWatch = false;
      render();
    });
    list.append(button);
  });
  renderGroupDetail();
}

function infoCard(label, value, wide) {
  const card = document.createElement("div");
  card.className = "info-card" + (wide ? " wide" : "");
  const name = document.createElement("span");
  name.textContent = label;
  const text = document.createElement("strong");
  text.textContent = value;
  card.append(name, text);
  return card;
}

function numberField(label, value, min, max, onChange) {
  const field = document.createElement("label");
  field.append(document.createTextNode(label));
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.inputMode = "numeric";
  input.value = String(value);
  input.addEventListener("change", () => {
    const number = Math.round(Number(input.value));
    const next = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
    input.value = String(next);
    onChange(next);
  });
  field.append(input);
  return field;
}

function slotWeekdays(kind) {
  if (kind === "saturday") return [5];
  if (kind === "sunday") return [6];
  if (kind === "weekend") return [5, 6];
  return [0, 1, 2, 3, 4];
}

function appendSlotBlock(parent, title, slots, note) {
  const block = document.createElement("div");
  block.className = "watch-block";
  const heading = document.createElement("p");
  heading.className = "group-label";
  heading.textContent = title;
  block.append(heading, renderSlotPills(slots));
  if (note) {
    const hint = document.createElement("p");
    hint.className = "hint slot-note";
    hint.textContent = note;
    block.append(hint);
  }
  parent.append(block);
}

function appendSlotEditor(parent, group, title, kind, selected, note) {
  const label = document.createElement("p");
  label.className = "group-label";
  label.textContent = title;
  const row = document.createElement("div");
  row.className = "chips";
  renderSlotChips(row, group, kind, selected);
  parent.append(label, row);
  if (note) {
    const hint = document.createElement("p");
    hint.className = "hint slot-note";
    hint.textContent = note;
    parent.append(hint);
  }
}

function renderSlotChips(row, group, kind, selected) {
  row.replaceChildren();
  cfgApi.offeredSlots(group, slotWeekdays(kind)).forEach((slot) => {
    const active = selected.includes(slot);
    row.append(
      chip(slot.replace("-", "–"), active, () => {
        const next = new Set(selected);
        if (next.has(slot)) next.delete(slot);
        else next.add(slot);
        applyGroupSlots(group, kind, [...next]);
        render();
      })
    );
  });
}

function sectionHead(titleText, editing, onToggle) {
  const head = document.createElement("div");
  head.className = "detail-head";
  const title = document.createElement("h3");
  title.textContent = titleText;
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "ghost";
  editButton.textContent = editing ? "닫기" : "수정";
  editButton.addEventListener("click", onToggle);
  head.append(title, editButton);
  return head;
}

function renderGroupDetail() {
  const root = document.querySelector("#group-detail");
  root.replaceChildren();
  const group = selectedGroup();
  if (!group) {
    root.textContent = "그룹이 없습니다.";
    return;
  }
  const today = seoulToday();
  const after = Number(group.after_days) || 0;
  const days = Math.max(1, Number(group.days) || 1);
  const start = addDays(today, after);
  let end = addDays(start, days - 1);
  const release = String(group.release || "").trim();
  const nowHm = seoulNowHm();
  if (release && /^\d{2}:\d{2}$/.test(release) && nowHm < release) {
    end = addDays(end, -1);
  }
  const watches = watchesInGroup(group);
  const detail = document.createElement("div");
  detail.className = "detail";
  root.append(detail);

  const title = document.createElement("h3");
  title.className = "group-title";
  title.textContent = plain(group.name) || "그룹";
  detail.append(title);

  const infoSection = document.createElement("section");
  infoSection.className = "group-section";
  infoSection.append(
    sectionHead("예약 · 코트", state.editingGroupInfo, () => {
      state.editingGroupInfo = !state.editingGroupInfo;
      render();
    })
  );

  if (!state.editingGroupInfo) {
    const info = document.createElement("div");
    info.className = "info-grid";
    info.append(
      infoCard("오늘로부터", `${after}일 뒤`),
      infoCard("예약 일수", `${days}일`),
      infoCard("보는 기간", `${formatMonthDay(start)} – ${formatMonthDay(end)}`, true),
      infoCard("코트 번호", (group.courts || []).join(", ") || "없음", true),
      infoCard("마지막 날 오픈", release || "없음"),
      infoCard("운영 시작", group.open || "06:00"),
      infoCard("운영 끝", group.close || "22:00")
    );
    infoSection.append(info);
  } else {
    const form = document.createElement("div");
    form.className = "grid";
    const nameField = document.createElement("label");
    nameField.className = "span-2";
    nameField.append(document.createTextNode("그룹 이름"));
    const nameInput = document.createElement("input");
    nameInput.value = group.name || "";
    nameInput.addEventListener("change", () => {
      group.name = nameInput.value.trim() || group.name;
      render();
    });
    nameField.append(nameInput);
    form.append(
      nameField,
      numberField("오늘로부터 며칠 뒤", after, 0, 60, (value) => {
        group.after_days = value;
        render();
      }),
      numberField("예약 가능 일수", days, 1, 60, (value) => {
        group.days = value;
        render();
      })
    );
    const releaseField = document.createElement("label");
    releaseField.append(document.createTextNode("마지막 날 오픈"));
    const releaseInput = document.createElement("input");
    releaseInput.type = "time";
    releaseInput.value = group.release || "";
    releaseInput.addEventListener("change", () => {
      group.release = cfgApi.normalizeRelease(releaseInput.value || "");
      render();
    });
    releaseField.append(releaseInput);
    const openField = document.createElement("label");
    openField.append(document.createTextNode("운영 시작"));
    const openInput = document.createElement("input");
    openInput.type = "time";
    openInput.value = group.open || "06:00";
    openInput.addEventListener("change", () => {
      group.open = openInput.value || "06:00";
      applyGroupHours(group);
      render();
    });
    openField.append(openInput);
    const closeField = document.createElement("label");
    closeField.append(document.createTextNode("운영 끝"));
    const closeInput = document.createElement("input");
    closeInput.type = "time";
    closeInput.value = group.close || "22:00";
    closeInput.addEventListener("change", () => {
      group.close = closeInput.value || "22:00";
      applyGroupHours(group);
      render();
    });
    closeField.append(closeInput);
    form.append(releaseField, openField, closeField);
    infoSection.append(form);
    const range = document.createElement("p");
    range.className = "hint";
    range.textContent = `${formatMonthDay(start)}부터 ${formatMonthDay(end)}까지`;
    infoSection.append(range);

    const courtsLabel = document.createElement("p");
    courtsLabel.className = "group-label";
    courtsLabel.textContent = "코트";
    infoSection.append(courtsLabel);
    watches.forEach((watch) => {
      const row = document.createElement("div");
      row.className = "row court-edit";
      const name = document.createElement("input");
      name.value = watch.name || "";
      name.placeholder = "코트 이름";
      name.addEventListener("change", () => {
        watch.name = name.value.trim() || `코트 ${watch.id}`;
      });
      const id = document.createElement("input");
      id.value = String(watch.id || "");
      id.inputMode = "numeric";
      id.placeholder = "번호";
      id.addEventListener("change", () => {
        const parsed = cfgApi.parseCourtAddress(id.value);
        if (!parsed) {
          say("코트 번호를 입력하세요.");
          id.value = String(watch.id || "");
          return;
        }
        if (
          state.config.watches.some(
            (item) => Number(item.id) === parsed.id && Number(item.id) !== Number(watch.id)
          )
        ) {
          say("이미 있는 코트 번호입니다.");
          id.value = String(watch.id || "");
          return;
        }
        const oldId = Number(watch.id);
        watch.id = parsed.id;
        watch.url = parsed.url;
        group.courts = (group.courts || []).map((item) =>
          Number(item) === oldId ? parsed.id : Number(item)
        );
        render();
      });
      const enabled = document.createElement("button");
      enabled.type = "button";
      enabled.textContent = watch.enabled === false ? "꺼짐" : "켜짐";
      enabled.classList.toggle("on", watch.enabled !== false);
      enabled.addEventListener("click", () => {
        watch.enabled = watch.enabled === false;
        render();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "빼기";
      remove.addEventListener("click", () => {
        group.courts = (group.courts || []).filter((item) => Number(item) !== Number(watch.id));
        state.config.watches = state.config.watches.filter(
          (item) => Number(item.id) !== Number(watch.id)
        );
        render();
      });
      row.append(name, id, enabled, remove);
      infoSection.append(row);
    });
    const addRow = document.createElement("div");
    addRow.className = "add-row";
    const addInput = document.createElement("input");
    addInput.placeholder = "코트 번호";
    addInput.inputMode = "numeric";
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.textContent = "코트 추가";
    addButton.addEventListener("click", () => {
      const parsed = cfgApi.parseCourtAddress(addInput.value);
      if (!parsed) {
        say("코트 번호를 입력하세요.");
        return;
      }
      if ((group.courts || []).map(Number).includes(parsed.id)) {
        say("이미 이 그룹에 있는 코트입니다.");
        return;
      }
      if (state.config.watches.some((item) => Number(item.id) === parsed.id)) {
        group.courts = [...(group.courts || []).map(Number), parsed.id];
      } else {
        state.config.watches.push(
          cfgApi.defaultWatch(parsed.id, parsed.url, {
            open: group.open,
            close: group.close,
            weekday_slots: groupWeekdaySlots(group),
            saturday_slots: groupSaturdaySlots(group),
            sunday_slots: groupSundaySlots(group),
            extras: groupExtras(group),
          })
        );
        group.courts = [...(group.courts || []).map(Number), parsed.id];
      }
      addInput.value = "";
      render();
    });
    addRow.append(addInput, addButton);
    infoSection.append(addRow);

    const removeGroup = document.createElement("button");
    removeGroup.type = "button";
    removeGroup.className = "danger";
    removeGroup.textContent = "이 그룹 삭제";
    removeGroup.addEventListener("click", () => {
      const ids = new Set((group.courts || []).map(Number));
      state.config.watches = state.config.watches.filter((watch) => !ids.has(Number(watch.id)));
      state.config.booking_groups.splice(state.selectedGroup, 1);
      state.selectedGroup = Math.max(0, state.selectedGroup - 1);
      state.editingGroupInfo = false;
      state.editingGroupWatch = false;
      render();
    });
    infoSection.append(removeGroup);
  }
  detail.append(infoSection);

  const watchSection = document.createElement("section");
  watchSection.className = "group-section";
  watchSection.append(
    sectionHead("감시", state.editingGroupWatch, () => {
      state.editingGroupWatch = !state.editingGroupWatch;
      render();
    })
  );

  if (!state.editingGroupWatch) {
    watchSection.append(renderWatchSummary(group));
  } else {
    appendSlotEditor(watchSection, group, "평일 감시 시간", "weekday", groupWeekdaySlots(group), "");
    if (cfgApi.weekendSplit(group)) {
      appendSlotEditor(watchSection, group, "토요일 감시 시간", "saturday", groupSaturdaySlots(group), closedDayNote(group, 5));
      appendSlotEditor(watchSection, group, "일요일 감시 시간", "sunday", groupSundaySlots(group), closedDayNote(group, 6));
    } else {
      appendSlotEditor(watchSection, group, "주말 감시 시간", "weekend", groupWeekendSlots(group), "");
    }

    const extrasLabel = document.createElement("p");
    extrasLabel.className = "group-label";
    extrasLabel.textContent = "추가 감시";
    const extrasHint = document.createElement("p");
    extrasHint.className = "hint";
    const closedNotes = [5, 6].map((day) => closedDayNote(group, day)).filter(Boolean);
    extrasHint.textContent = closedNotes.length
      ? `특정 요일이나 날짜만 시간을 더하거나, 그날만 다른 시간으로 바꿉니다. ${closedNotes.join(" ")}`
      : "특정 요일이나 날짜만 시간을 더하거나, 그날만 다른 시간으로 바꿉니다.";
    watchSection.append(extrasLabel, extrasHint);
    renderExtrasEditor(watchSection, group);
  }
  detail.append(watchSection);
}

function renderExtrasEditor(detail, group) {
  const extras = groupExtras(group);
  const list = document.createElement("div");
  list.className = "extras-list";
  extras.forEach((extra, index) => {
    const card = document.createElement("div");
    card.className = "extra-card";
    const head = document.createElement("div");
    head.className = "detail-head";
    const title = document.createElement("strong");
    title.textContent = extra.label || `추가 ${index + 1}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger ghost";
    remove.textContent = "삭제";
    remove.addEventListener("click", () => {
      extras.splice(index, 1);
      applyGroupExtras(group, extras);
      render();
    });
    head.append(title, remove);
    card.append(head);

    const labelField = document.createElement("label");
    labelField.append(document.createTextNode("이름"));
    const labelInput = document.createElement("input");
    labelInput.value = extra.label || "";
    labelInput.placeholder = "예: 수요일 저녁";
    labelInput.addEventListener("change", () => {
      extras[index].label = labelInput.value.trim();
      applyGroupExtras(group, extras);
      render();
    });
    labelField.append(labelInput);
    card.append(labelField);

    const dayLabel = document.createElement("p");
    dayLabel.className = "group-label";
    dayLabel.textContent = "요일";
    const dayRow = document.createElement("div");
    dayRow.className = "chips day-chips";
    cfgApi.WEEKDAYS.forEach((label, day) => {
      const selected = (extra.weekdays || []).includes(day);
      dayRow.append(
        chip(label, selected, () => {
          const days = new Set(extra.weekdays || []);
          if (days.has(day)) days.delete(day);
          else days.add(day);
          extras[index].weekdays = [...days].sort((a, b) => a - b);
          applyGroupExtras(group, extras);
          render();
        })
      );
    });
    card.append(dayLabel, dayRow);

    const dateLabel = document.createElement("p");
    dateLabel.className = "group-label";
    dateLabel.textContent = "특정 날짜";
    const dateRow = document.createElement("div");
    dateRow.className = "add-row";
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    const dateAdd = document.createElement("button");
    dateAdd.type = "button";
    dateAdd.className = "ghost";
    dateAdd.textContent = "날짜 추가";
    dateAdd.addEventListener("click", () => {
      const value = dateInput.value;
      if (!value) {
        say("날짜를 고르세요.");
        return;
      }
      const dates = new Set(extra.dates || []);
      dates.add(value);
      extras[index].dates = [...dates].sort();
      dateInput.value = "";
      applyGroupExtras(group, extras);
      render();
    });
    dateRow.append(dateInput, dateAdd);
    card.append(dateLabel, dateRow);
    const dateList = document.createElement("div");
    dateList.className = "date-list";
    (extra.dates || []).forEach((day) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "ghost";
      pill.textContent = `${day} ×`;
      pill.addEventListener("click", () => {
        extras[index].dates = (extra.dates || []).filter((item) => item !== day);
        applyGroupExtras(group, extras);
        render();
      });
      dateList.append(pill);
    });
    if ((extra.dates || []).length) card.append(dateList);

    const slotLabel = document.createElement("p");
    slotLabel.className = "group-label";
    slotLabel.textContent = "시간";
    const slotRow = document.createElement("div");
    slotRow.className = "chips";
    const extraDays = (extra.weekdays || []).length ? extra.weekdays : [0, 1, 2, 3, 4, 5, 6];
    cfgApi.offeredSlots(group, extraDays).forEach((slot) => {
      const selected = (extra.slots || []).includes(slot);
      slotRow.append(
        chip(slot.replace("-", "–"), selected, () => {
          const slots = new Set(extra.slots || []);
          if (slots.has(slot)) slots.delete(slot);
          else slots.add(slot);
          extras[index].slots = [...slots].sort();
          applyGroupExtras(group, extras);
          render();
        })
      );
    });
    card.append(slotLabel, slotRow);

    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "toggle" + (extra.replace ? " on" : "");
    replace.textContent = extra.replace ? "기본 시간 대신 쓰기" : "기본 시간에 추가";
    replace.addEventListener("click", () => {
      extras[index].replace = !extra.replace;
      applyGroupExtras(group, extras);
      render();
    });
    card.append(replace);
    const summary = document.createElement("p");
    summary.className = "hint";
    summary.textContent = describeExtra(extras[index]);
    card.append(summary);
    list.append(card);
  });
  detail.append(list);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary";
  add.textContent = "추가 감시 만들기";
  add.addEventListener("click", () => {
    extras.push({
      label: "",
      weekdays: [],
      dates: [],
      slots: [],
      replace: false,
    });
    if (!applyGroupExtras(group, extras)) return;
    render();
  });
  detail.append(add);
}

function renderStatusPulse() {
  const pulse = document.querySelector("#status-pulse");
  pulse.hidden = !(state.status && state.status.last_check);
}

function render() {
  const canEdit = loggedIn() && Boolean(state.config);
  document.querySelector("#workspace").hidden = !canEdit;
  document.querySelector("#general-card").hidden = !canEdit;
  document.querySelector("#guest-note").hidden = loggedIn();
  document.querySelectorAll(".save-button").forEach((button) => {
    button.hidden = !canEdit;
  });
  renderStatus();
  renderStatusPulse();
  if (!canEdit) return;
  renderGeneral();
  renderGroups();
}

function openSheet(id) {
  const sheet = document.querySelector(id);
  if (sheet && typeof sheet.showModal === "function") sheet.showModal();
}

document.querySelectorAll(".sheet-close").forEach((button) => {
  button.addEventListener("click", () => {
    const sheet = button.closest("dialog");
    if (sheet) sheet.close();
  });
});
document.querySelector("#account-button").addEventListener("click", () => {
  sayAccount("");
  openSheet("#account-sheet");
});
document.querySelector("#tools-button").addEventListener("click", () => {
  sayTools("");
  openSheet("#tools-sheet");
});
document.querySelector("#check-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#check-word");
  const word = input.value;
  runCheck(word).catch(() => sayTools("예약 정보를 읽지 못했습니다"));
});
document.querySelector("#email-edit-button").addEventListener("click", () => {
  const emailInput = document.querySelector("#email");
  const edit = document.querySelector("#email-edit-button");
  if (!emailInput.readOnly) {
    resetEmailEditor();
    return;
  }
  emailInput.readOnly = false;
  edit.setAttribute("aria-pressed", "true");
  emailInput.focus();
  emailInput.select();
});
document.querySelector("#sign-in-form").addEventListener("submit", (event) => {
  event.preventDefault();
  signIn()
    .then(() => {
      const sheet = document.querySelector("#account-sheet");
      if (sheet && sheet.open) sheet.close();
    })
    .catch((error) => sayAccount(firebaseMessage(error)));
});
document.querySelector("#password").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  document.querySelector("#sign-in-form").requestSubmit();
});
document.querySelector("#sign-out-button").addEventListener("click", () => {
  if (!auth) return;
  auth
    .signOut()
    .then(() => {
      sayAccount("");
      closeEditors();
      const sheet = document.querySelector("#account-sheet");
      if (sheet && sheet.open) sheet.close();
    })
    .catch((error) => sayAccount(firebaseMessage(error)));
});
document.querySelectorAll(".save-button").forEach((button) => {
  button.addEventListener("click", () => {
    saveRepo().catch((error) => say(firebaseMessage(error)));
  });
});
document.querySelector("#test-button").addEventListener("click", () => {
  testNtfy().catch(() => sayTools("테스트 알림을 보내지 못했습니다."));
});
document.querySelector("#add-group-button").addEventListener("click", () => {
  if (!state.config) return;
  const name = document.querySelector("#add-group-name").value.trim();
  if (!name) {
    say("그룹 이름을 입력하세요.");
    return;
  }
  const id = "group" + Date.now().toString(36);
  state.config.booking_groups.push({
    id,
    name,
    courts: [],
    after_days: 1,
    days: 14,
    release: "09:00",
    open: "06:00",
    close: "22:00",
  });
  state.selectedGroup = state.config.booking_groups.length - 1;
  state.editingGroupInfo = true;
  state.editingGroupWatch = false;
  document.querySelector("#add-group-name").value = "";
  render();
});

if (location.search) {
  history.replaceState({}, "", location.pathname);
}

loadLocal();
render();
if (!firebaseReady()) {
  say("Firebase가 설정되지 않았습니다");
} else {
  firebase.initializeApp(window.FIREBASE_CONFIG);
  auth = firebase.auth();
  db = firebase.firestore();
  auth.onAuthStateChanged((user) => {
    signedIn(user).catch((error) => say(firebaseMessage(error)));
  });
}
