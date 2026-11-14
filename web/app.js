const cfgApi = window.CourtConfig;
const fields = ["owner", "repo", "branch", "token", "topic", "server", "ntfy-token"];
const state = {
  config: null,
  sha: null,
  status: null,
  selected: 0,
};

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
  if (!document.querySelector("#server").value) {
    document.querySelector("#server").value = "https://ntfy.sh";
  }
  const host = window.location.hostname;
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (host.endsWith(".github.io") && !document.querySelector("#owner").value) {
    document.querySelector("#owner").value = host.replace(".github.io", "");
    if (parts[0]) document.querySelector("#repo").value = parts[0];
  }
}

function saveLocal() {
  fields.forEach((name) => {
    localStorage.setItem(storageKey(name), document.querySelector("#" + name).value.trim());
  });
}

function repoPath() {
  const owner = document.querySelector("#owner").value.trim();
  const repo = document.querySelector("#repo").value.trim();
  const branch = document.querySelector("#branch").value.trim() || "main";
  return { owner, repo, branch };
}

function authHeaders() {
  const token = document.querySelector("#token").value.trim();
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "court-watch-settings",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((item) => {
    binary += String.fromCharCode(item);
  });
  return btoa(binary);
}

function decodeBase64(data) {
  const binary = atob(String(data).replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function githubFile(path) {
  const { owner, repo, branch } = repoPath();
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    { headers: authHeaders() }
  );
  if (!response.ok) throw new Error(`${path} 을 읽지 못했습니다`);
  return response.json();
}

async function loadRepo() {
  saveLocal();
  const file = await githubFile("config.yaml");
  state.sha = file.sha;
  state.config = cfgApi.parseConfig(decodeBase64(file.content));
  try {
    const statusFile = await githubFile("state/slots.json");
    state.status = JSON.parse(decodeBase64(statusFile.content));
  } catch (error) {
    state.status = null;
  }
  if (state.selected >= state.config.watches.length) state.selected = 0;
  render();
  document.querySelector("#link-card").open = false;
  say("불러왔습니다.");
}

async function saveRepo() {
  saveLocal();
  if (!state.config || !state.sha) {
    say("먼저 불러오세요.");
    return;
  }
  const { owner, repo, branch } = repoPath();
  const body = {
    message: "Update court watch settings",
    content: encodeBase64(cfgApi.dumpConfig(state.config)),
    sha: state.sha,
    branch,
  };
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/config.yaml`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 409) {
    say("다른 저장이 먼저 있었습니다. 다시 불러오세요.");
    return;
  }
  if (!response.ok) {
    say("저장하지 못했습니다. 토큰의 contents 권한을 확인하세요.");
    return;
  }
  const payload = await response.json();
  state.sha = payload.content.sha;
  say("저장했습니다. 다음 검사부터 적용됩니다.");
}

async function testNtfy() {
  saveLocal();
  const topic = document.querySelector("#topic").value.trim();
  const server = (document.querySelector("#server").value.trim() || "https://ntfy.sh").replace(/\/$/, "");
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
  checked.className = "status-line";
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
  document.querySelector("#court-card").hidden = !ready;
  document.querySelectorAll(".save-button").forEach((button) => {
    button.hidden = !ready;
  });
  renderStatus();
  if (!ready) return;
  renderGeneral();
  renderCourts();
}

document.querySelector("#load-button").addEventListener("click", () => {
  loadRepo().catch((error) => say(error.message));
});
document.querySelectorAll(".save-button").forEach((button) => {
  button.addEventListener("click", () => {
    saveRepo().catch((error) => say(error.message));
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
