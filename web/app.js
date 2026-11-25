const cfgApi = window.CourtConfig;
const checkApi = window.CourtCheck;
const NTFY_SERVER = "https://ntfy.sh";
const fields = ["topic", "ntfy-token"];
const state = {
  config: null,
  status: null,
  selectedGroup: 0,
  editingGroup: false,
};
let auth = null;
let db = null;

const message = document.querySelector("#message");

function say(text) {
  message.textContent = text || "";
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
  const signInButton = document.querySelector("#sign-in-button");
  const signOutButton = document.querySelector("#sign-out-button");
  account.textContent = user && user.email ? user.email : "";
  signInForm.hidden = Boolean(user);
  signInButton.hidden = Boolean(user);
  signOutButton.hidden = !user;
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
  state.config.booking_groups = cfgApi.normalizeGroups(state.config.booking_groups);
  state.config.watches = (state.config.watches || []).map(cfgApi.normalizeWatch);
  syncGroupsFromWatches();
  const statusSnap = await db.collection("courtwatch").doc("state").get();
  state.status = statusSnap.exists ? statusSnap.data() : null;
  if (state.selectedGroup >= (state.config.booking_groups || []).length) state.selectedGroup = 0;
  state.editingGroup = false;
  render();
  say("불러왔습니다.");
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

function groupWeekendSlots(group) {
  const watches = watchesInGroup(group);
  return watches[0] ? [...(watches[0].weekend_slots || [])] : [];
}

function applyGroupSlots(group, kind, slots) {
  const sorted = [...slots].sort();
  watchesInGroup(group).forEach((watch) => {
    if (kind === "weekday") watch.weekday_slots = [...sorted];
    else watch.weekend_slots = [...sorted];
    const next = cfgApi.normalizeWatch(watch);
    Object.assign(watch, next);
  });
}

function applyGroupHours(group) {
  watchesInGroup(group).forEach((watch) => {
    watch.open = group.open || "06:00";
    watch.close = group.close || "22:00";
  });
}

function loggedIn() {
  return Boolean(auth && auth.currentUser);
}

async function signedIn(user) {
  showAccount(user);
  await loadDocs();
}

async function signIn() {
  saveLocal();
  if (!auth) {
    say("Firebase가 설정되지 않았습니다");
    return;
  }
  const email = document.querySelector("#email").value.trim();
  const password = document.querySelector("#password").value;
  if (!email || !password) {
    say("이메일과 비밀번호를 입력하세요.");
    return;
  }
  await auth.signInWithEmailAndPassword(email, password);
  document.querySelector("#password").value = "";
  say("로그인했습니다.");
}

async function saveRepo() {
  saveLocal();
  if (!auth || !auth.currentUser || !state.config) {
    say("먼저 로그인하세요.");
    return;
  }
  state.config.booking_groups = cfgApi.normalizeGroups(state.config.booking_groups);
  state.config.watches = (state.config.watches || []).map(cfgApi.normalizeWatch);
  applyGroupHoursToAll();
  await db.collection("courtwatch").doc("config").set(state.config);
  say("저장했습니다. 다음 검사부터 적용됩니다.");
}

function applyGroupHoursToAll() {
  (state.config.booking_groups || []).forEach((group) => applyGroupHours(group));
}

async function testNtfy() {
  saveLocal();
  const topic = document.querySelector("#topic").value.trim();
  const server = NTFY_SERVER;
  if (!topic) {
    say("ntfy 토픽을 입력하세요.");
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
  say(response.ok ? "테스트 알림을 보냈습니다." : "테스트 알림을 보내지 못했습니다.");
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
    say("체크라고 입력하세요.");
    return;
  }
  if (!state.config) {
    say("아직 설정이 없습니다.");
    return;
  }
  const button = document.querySelector("#check-form button");
  button.disabled = true;
  say("확인 중입니다.");
  try {
    const result = await checkApi.loadPreview(state.config, state.status, seoulTodayIso());
    renderCheckResult(result);
    say("");
  } catch (error) {
    document.querySelector("#check-result").replaceChildren();
    say(error && error.message ? error.message : "예약 정보를 읽지 못했습니다");
  } finally {
    button.disabled = false;
  }
}

function renderStatus() {
  const box = document.querySelector("#status");
  box.replaceChildren();
  const current = state.status;
  if (!current) {
    box.textContent = "아직 검사 기록이 없습니다.";
    return;
  }
  const watches = Object.fromEntries(((state.config && state.config.watches) || []).map((watch) => [String(watch.id), watch]));
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
  const open = current.open_now || [];
  const summary = document.createElement("p");
  summary.className = "status-line";
  summary.textContent = open.length ? `빈 시간 ${open.length}개` : "지금 빈 시간 없음";
  box.append(summary);
  if (!open.length) return;
  const list = document.createElement("ul");
  list.className = "status-list";
  open.forEach((key) => {
    const [id, day, slot] = key.split("|");
    const item = document.createElement("li");
    const name = plain((watches[id] || {}).name) || id;
    item.textContent = `${name}  ${day}  ${slot}`;
    list.append(item);
  });
  box.append(list);
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

function renderGeneral() {
  const config = state.config;
  const alertButton = document.querySelector("#alert-toggle");
  const on = config.alerts_enabled !== false;
  alertButton.textContent = on ? "알림 켜짐" : "알림 꺼짐";
  alertButton.classList.toggle("on", on);
  const sleep = config.sleep || {};
  const same = sleep.start && sleep.start === sleep.end;
  document.querySelector("#sleep-start").value = same ? "" : sleep.start || "";
  document.querySelector("#sleep-end").value = same ? "" : sleep.end || "";
  document.querySelectorAll("[data-sleep]").forEach((button) => {
    const [start, end] = button.dataset.sleep.split(",");
    button.classList.toggle("active", sleep.start === start && sleep.end === end);
  });
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
    button.className = "court" + (index === state.selectedGroup ? " active" : "");
    const title = document.createElement("strong");
    title.textContent = plain(group.name) || "그룹";
    const detail = document.createElement("small");
    const courts = (group.courts || []).map(String).join(", ") || "코트 없음";
    detail.textContent = `코트 ${courts}`;
    button.append(title, document.createElement("br"), detail);
    button.addEventListener("click", () => {
      state.selectedGroup = index;
      state.editingGroup = false;
      render();
    });
    list.append(button);
  });
  renderGroupDetail();
}

function infoLine(label, value) {
  const row = document.createElement("p");
  row.className = "info-line";
  const name = document.createElement("span");
  name.textContent = label;
  const text = document.createElement("strong");
  text.textContent = value;
  row.append(name, text);
  return row;
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

function renderSlotChips(row, group, kind, selected) {
  row.replaceChildren();
  cfgApi.menuSlots(group.open || "06:00", group.close || "22:00").forEach((slot) => {
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
  const end = addDays(start, days - 1);
  const watches = watchesInGroup(group);
  const detail = document.createElement("div");
  detail.className = "detail";
  root.append(detail);

  const head = document.createElement("div");
  head.className = "row";
  const title = document.createElement("h3");
  title.textContent = plain(group.name) || "그룹";
  head.append(title);
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "secondary";
  editButton.textContent = state.editingGroup ? "수정 닫기" : "수정";
  editButton.addEventListener("click", () => {
    state.editingGroup = !state.editingGroup;
    render();
  });
  head.append(editButton);
  detail.append(head);

  if (!state.editingGroup) {
    detail.append(
      infoLine("오늘로부터 며칠 뒤", `${after}일`),
      infoLine("예약 가능 일수", `${days}일`),
      infoLine("보는 기간", `${formatMonthDay(start)}부터 ${formatMonthDay(end)}까지`),
      infoLine("코트 번호", (group.courts || []).join(", ") || "없음"),
      infoLine("운영 시작", group.open || "06:00"),
      infoLine("운영 끝", group.close || "22:00")
    );
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
    form.append(openField, closeField);
    detail.append(form);
    const range = document.createElement("p");
    range.className = "hint";
    range.textContent = `${formatMonthDay(start)}부터 ${formatMonthDay(end)}까지`;
    detail.append(range);

    const courtsLabel = document.createElement("p");
    courtsLabel.className = "group-label";
    courtsLabel.textContent = "코트";
    detail.append(courtsLabel);
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
      detail.append(row);
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
            weekend_slots: groupWeekendSlots(group),
          })
        );
        group.courts = [...(group.courts || []).map(Number), parsed.id];
      }
      addInput.value = "";
      render();
    });
    addRow.append(addInput, addButton);
    detail.append(addRow);

    const removeGroup = document.createElement("button");
    removeGroup.type = "button";
    removeGroup.className = "danger";
    removeGroup.textContent = "이 그룹 삭제";
    removeGroup.addEventListener("click", () => {
      const ids = new Set((group.courts || []).map(Number));
      state.config.watches = state.config.watches.filter((watch) => !ids.has(Number(watch.id)));
      state.config.booking_groups.splice(state.selectedGroup, 1);
      state.selectedGroup = Math.max(0, state.selectedGroup - 1);
      state.editingGroup = false;
      render();
    });
    detail.append(removeGroup);
  }

  const weekdayLabel = document.createElement("p");
  weekdayLabel.className = "group-label";
  weekdayLabel.textContent = "평일 감시 시간";
  const weekdayRow = document.createElement("div");
  weekdayRow.className = "chips";
  renderSlotChips(weekdayRow, group, "weekday", groupWeekdaySlots(group));
  const weekendLabel = document.createElement("p");
  weekendLabel.className = "group-label";
  weekendLabel.textContent = "주말 감시 시간";
  const weekendRow = document.createElement("div");
  weekendRow.className = "chips";
  renderSlotChips(weekendRow, group, "weekend", groupWeekendSlots(group));
  detail.append(weekdayLabel, weekdayRow, weekendLabel, weekendRow);
}

function render() {
  const canEdit = loggedIn() && Boolean(state.config);
  document.querySelector("#general-card").hidden = !canEdit;
  document.querySelector("#groups-card").hidden = !canEdit;
  document.querySelectorAll(".save-button").forEach((button) => {
    button.hidden = !canEdit;
  });
  renderStatus();
  if (!canEdit) return;
  renderGeneral();
  renderGroups();
}

document.querySelector("#tools-button").addEventListener("click", () => {
  const cards = document.querySelectorAll(".tool-card");
  const open = cards[0].hidden;
  cards.forEach((card) => {
    card.hidden = !open;
  });
  document.querySelector("#tools-button").textContent = open ? "테스트 닫기" : "테스트";
});
document.querySelector("#check-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#check-word");
  const word = input.value;
  runCheck(word).catch(() => say("예약 정보를 읽지 못했습니다"));
});
document.querySelector("#sign-in-form").addEventListener("submit", (event) => {
  event.preventDefault();
  signIn().catch((error) => say(firebaseMessage(error)));
});
document.querySelector("#sign-out-button").addEventListener("click", () => {
  if (!auth) return;
  auth.signOut().catch((error) => say(firebaseMessage(error)));
});
document.querySelectorAll(".save-button").forEach((button) => {
  button.addEventListener("click", () => {
    saveRepo().catch((error) => say(firebaseMessage(error)));
  });
});
document.querySelector("#test-button").addEventListener("click", () => {
  testNtfy().catch(() => say("테스트 알림을 보내지 못했습니다."));
});
document.querySelector("#alert-toggle").addEventListener("click", () => {
  if (!state.config) return;
  state.config.alerts_enabled = state.config.alerts_enabled === false;
  render();
});
document.querySelectorAll("[data-sleep]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!state.config) return;
    const [start, end] = button.dataset.sleep.split(",");
    state.config.sleep = { start, end };
    render();
  });
});
document.querySelector("#sleep-apply").addEventListener("click", () => {
  if (!state.config) return;
  let start = document.querySelector("#sleep-start").value;
  let end = document.querySelector("#sleep-end").value;
  if (!start && !end) {
    start = "00:00";
    end = "00:00";
  }
  state.config.sleep = { start, end };
  render();
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
    open: "06:00",
    close: "22:00",
  });
  state.selectedGroup = state.config.booking_groups.length - 1;
  state.editingGroup = true;
  document.querySelector("#add-group-name").value = "";
  render();
});

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
