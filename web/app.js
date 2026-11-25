const cfgApi = window.CourtConfig;
const checkApi = window.CourtCheck;
const NTFY_SERVER = "https://ntfy.sh";
const fields = ["topic", "ntfy-token"];
const state = {
  config: null,
  status: null,
  selected: 0,
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
  if (code === "permission-denied") return "이 계정은 설정을 읽을 수 없습니다.";
  if (code === "auth/popup-closed-by-user") return "로그인을 취소했습니다.";
  return (error && error.message) || "Firebase 요청에 실패했습니다.";
}

function showAccount(user) {
  const account = document.querySelector("#account");
  const signInButton = document.querySelector("#sign-in-button");
  const signOutButton = document.querySelector("#sign-out-button");
  account.textContent = user && user.email ? user.email : "";
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
  state.config.watches = state.config.watches || [];
  state.config.presets = state.config.presets || [];
  state.config.booking_groups = state.config.booking_groups || [];
  state.config.sleep = state.config.sleep || { start: "02:00", end: "02:00" };
  const statusSnap = await db.collection("courtwatch").doc("state").get();
  state.status = statusSnap.exists ? statusSnap.data() : null;
  if (state.selected >= (state.config.watches || []).length) state.selected = 0;
  render();
  document.querySelector("#link-card").open = false;
  say("불러왔습니다.");
}

async function signedIn(user) {
  showAccount(user);
  if (!user) {
    state.config = null;
    state.status = null;
    render();
    return;
  }
  await loadDocs();
}

async function signIn() {
  saveLocal();
  if (!auth) {
    say("Firebase가 설정되지 않았습니다");
    return;
  }
  const provider = new firebase.auth.GoogleAuthProvider();
  await auth.signInWithPopup(provider);
}

async function saveRepo() {
  saveLocal();
  if (!auth || !auth.currentUser || !state.config) {
    say("먼저 로그인하세요.");
    return;
  }
  await db.collection("courtwatch").doc("config").set(state.config);
  say("저장했습니다. 다음 검사부터 적용됩니다.");
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
    say("먼저 로그인하세요.");
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
  const watches = Object.fromEntries((state.config.watches || []).map((watch) => [String(watch.id), watch]));
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

function renderBooking() {
  const box = document.querySelector("#booking-groups");
  box.replaceChildren();
  const today = seoulToday();
  (state.config.booking_groups || []).forEach((group) => {
    const block = document.createElement("div");
    block.className = "booking-group";
    const title = document.createElement("p");
    title.className = "group-label";
    title.textContent = plain(group.name) || "예약";
    const names = document.createElement("p");
    names.className = "hint";
    const courts = (group.courts || []).map((id) => {
      const watch = (state.config.watches || []).find((item) => Number(item.id) === Number(id));
      return plain(watch && watch.name) || String(id);
    });
    names.textContent = courts.join(", ");
    const row = document.createElement("div");
    row.className = "time-row";
    const range = document.createElement("p");
    range.className = "hint";

    function refreshRange() {
      const after = Number(group.after_days) || 0;
      const days = Math.max(1, Number(group.days) || 1);
      const start = addDays(today, after);
      const end = addDays(start, days - 1);
      range.textContent = `${formatMonthDay(start)}부터 ${formatMonthDay(end)}까지`;
    }

    function numberField(label, key, min, max) {
      const field = document.createElement("label");
      field.append(document.createTextNode(label));
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.inputMode = "numeric";
      input.value = String(group[key]);
      input.addEventListener("change", () => {
        const number = Math.round(Number(input.value));
        const next = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
        group[key] = next;
        input.value = String(next);
        refreshRange();
      });
      field.append(input);
      return field;
    }

    row.append(
      numberField("오늘로부터 며칠 뒤", "after_days", 0, 60),
      numberField("예약 가능 일수", "days", 1, 60)
    );
    refreshRange();
    block.append(title, names, row, range);
    box.append(block);
  });
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

function renderCourts() {
  const list = document.querySelector("#court-list");
  list.innerHTML = "";
  state.config.watches.forEach((watch, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "court" + (index === state.selected ? " active" : "") + (watch.enabled === false ? " is-off" : "");
    button.setAttribute("aria-pressed", index === state.selected ? "true" : "false");
    const title = document.createElement("strong");
    title.textContent = plain(watch.name) || "코트 " + watch.id;
    const detail = document.createElement("small");
    detail.textContent = `${watch.enabled === false ? "꺼짐" : "켜짐"} · ${cfgApi.formatWeekdays(watch.weekdays)}`;
    button.append(title, document.createElement("br"), detail);
    button.addEventListener("click", () => {
      state.selected = index;
      render();
    });
    list.appendChild(button);
  });
  renderDetail();
}

function chip(label, active, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.classList.toggle("active", active);
  button.addEventListener("click", onClick);
  return button;
}

function renderDetail() {
  const root = document.querySelector("#court-detail");
  const watch = state.config.watches[state.selected];
  root.innerHTML = "";
  if (!watch) {
    root.textContent = "코트가 없습니다.";
    return;
  }
  const detail = document.createElement("div");
  detail.className = "detail";
  detail.innerHTML = `
    <div class="grid">
      <label>이름<input data-field="name" value=""></label>
      <label class="span-2">코트 번호<input data-field="url" value="" inputmode="text" autocomplete="off"></label>
      <label>운영 시작<input data-field="open" type="time"></label>
      <label>운영 끝<input data-field="close" type="time"></label>
    </div>
    <p class="group-label">요일</p>
    <div class="row day-presets" id="day-presets"></div>
    <div class="weekdays" id="weekday-row"></div>
    <p class="group-label">빠른 선택</p>
    <div class="row presets" id="preset-row"></div>
    <p class="group-label">시간</p>
    <div class="chips" id="slot-row"></div>
    <div class="row">
      <button type="button" id="enabled-button"></button>
      <button type="button" id="delete-button" class="danger">이 코트 빼기</button>
    </div>
  `;
  root.appendChild(detail);
  detail.querySelector('[data-field="name"]').value = watch.name || "";
  detail.querySelector('[data-field="url"]').value = String(watch.id || "");
  detail.querySelector('[data-field="open"]').value = watch.open || "06:00";
  detail.querySelector('[data-field="close"]').value = watch.close || "22:00";
  detail.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("change", () => {
      const field = input.dataset.field;
      if (field === "url") {
        const parsed = cfgApi.parseCourtAddress(input.value);
        if (!parsed) {
          say("예약 주소 또는 코트 번호를 입력하세요.");
          input.value = watch.url || "";
          return;
        }
        const duplicate = state.config.watches.some(
          (item, index) => index !== state.selected && Number(item.id) === parsed.id
        );
        if (duplicate) {
          say("이미 감시 중인 코트입니다.");
          input.value = watch.url || "";
          return;
        }
        if (Number(watch.id) !== parsed.id) {
          watch.id = parsed.id;
          watch.name = `코트 ${parsed.id}`;
        }
        watch.url = parsed.url;
        input.value = parsed.url;
      } else {
        watch[field] = input.value;
      }
      renderCourts();
    });
  });

  const weekdayRow = detail.querySelector("#weekday-row");
  detail.querySelector("#day-presets").append(
    chip("매일", cfgApi.formatWeekdays(watch.weekdays) === "매일", () => setDays([0, 1, 2, 3, 4, 5, 6])),
    chip("평일", cfgApi.formatWeekdays(watch.weekdays) === "평일", () => setDays([0, 1, 2, 3, 4])),
    chip("주말", cfgApi.formatWeekdays(watch.weekdays) === "주말", () => setDays([5, 6]))
  );
  cfgApi.WEEKDAYS.forEach((label, index) => {
    const selected = (watch.weekdays || []).map(Number).includes(index);
    weekdayRow.append(
      chip(label, selected, () => {
        const days = new Set((watch.weekdays || []).map(Number));
        if (days.has(index)) days.delete(index);
        else days.add(index);
        setDays([...days]);
      })
    );
  });

  const presetRow = detail.querySelector("#preset-row");
  (state.config.presets || []).forEach((preset) => {
    presetRow.append(
      chip(preset.label || preset.id, false, () => {
        watch.weekdays = (preset.weekdays || []).map(Number);
        watch.slots = [...(preset.slots || [])];
        watch.enabled = true;
        render();
      })
    );
  });

  const slotRow = detail.querySelector("#slot-row");
  cfgApi.menuSlots(watch.open, watch.close).forEach((slot) => {
    const selected = (watch.slots || []).includes(slot);
    slotRow.append(
      chip(slot.replace("-", "–"), selected, () => {
        const slots = new Set(watch.slots || []);
        if (slots.has(slot)) slots.delete(slot);
        else slots.add(slot);
        watch.slots = [...slots].sort();
        render();
      })
    );
  });

  const enabled = detail.querySelector("#enabled-button");
  enabled.textContent = watch.enabled === false ? "감시 꺼짐" : "감시 켜짐";
  enabled.classList.toggle("on", watch.enabled !== false);
  enabled.addEventListener("click", () => {
    watch.enabled = watch.enabled === false;
    render();
  });
  detail.querySelector("#delete-button").addEventListener("click", () => {
    state.config.watches.splice(state.selected, 1);
    state.selected = Math.max(0, state.selected - 1);
    render();
  });
}

function setDays(days) {
  const watch = state.config.watches[state.selected];
  if (!watch) return;
  watch.weekdays = [...new Set(days)].sort((a, b) => a - b);
  render();
}

function render() {
  const ready = Boolean(state.config);
  document.querySelector("#general-card").hidden = !ready;
  document.querySelector("#booking-card").hidden = !ready;
  document.querySelector("#court-card").hidden = !ready;
  document.querySelectorAll(".save-button").forEach((button) => {
    button.hidden = !ready;
  });
  renderStatus();
  if (!ready) return;
  renderGeneral();
  renderBooking();
  renderCourts();
}

document.querySelector("#check-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#check-word");
  const word = input.value;
  runCheck(word).catch(() => say("예약 정보를 읽지 못했습니다"));
});
document.querySelector("#sign-in-button").addEventListener("click", () => {
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
document.querySelector("#add-button").addEventListener("click", () => {
  if (!state.config) return;
  const parsed = cfgApi.parseCourtAddress(document.querySelector("#add-address").value);
  if (!parsed) {
    say("코트 번호 또는 예약 주소를 입력하세요.");
    return;
  }
  if (state.config.watches.some((watch) => Number(watch.id) === parsed.id)) {
    say("이미 감시 중인 코트입니다.");
    return;
  }
  state.config.watches.push(cfgApi.defaultWatch(parsed.id, parsed.url));
  state.selected = state.config.watches.length - 1;
  document.querySelector("#add-address").value = "";
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
