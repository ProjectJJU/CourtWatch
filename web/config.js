(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.CourtConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];
  const COURT_URL = "https://www.yssisul.or.kr/rent/#/{id}/rent/step1";

  function parseScalar(raw) {
    const value = String(raw).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (!inner) return [];
      return splitFlow(inner).map(parseScalar);
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null" || value === "~" || value === "") return null;
    if (/^-?\d+$/.test(value)) return Number(value);
    return value;
  }

  function splitFlow(inner) {
    const parts = [];
    let current = "";
    let quote = "";
    for (const ch of inner) {
      if (quote) {
        current += ch;
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === ",") {
        parts.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  function parseConfig(text) {
    const lines = String(text)
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"));
    let index = 0;

    function indentOf(line) {
      return line.match(/^ */)[0].length;
    }

    function parseBlock(minIndent) {
      if (
        index < lines.length &&
        indentOf(lines[index]) >= minIndent &&
        lines[index].trim().startsWith("- ")
      ) {
        const list = [];
        const indent = indentOf(lines[index]);
        while (
          index < lines.length &&
          indentOf(lines[index]) === indent &&
          lines[index].trim().startsWith("- ")
        ) {
          const raw = lines[index].trim().slice(2);
          index += 1;
          if (raw.includes(":")) {
            const colon = raw.indexOf(":");
            const item = {};
            const inline = raw.slice(colon + 1).trim();
            item[raw.slice(0, colon).trim()] = inline ? parseScalar(inline) : null;
            while (index < lines.length && indentOf(lines[index]) > indent) {
              const child = lines[index].trim();
              if (child.startsWith("- ")) break;
              const childIndent = indentOf(lines[index]);
              const childColon = child.indexOf(":");
              const key = child.slice(0, childColon).trim();
              const val = child.slice(childColon + 1).trim();
              index += 1;
              item[key] = val ? parseScalar(val) : parseBlock(childIndent + 1);
            }
            list.push(item);
          } else {
            list.push(parseScalar(raw));
          }
        }
        return list;
      }

      const map = {};
      if (index >= lines.length || indentOf(lines[index]) < minIndent) return map;
      const indent = indentOf(lines[index]);
      while (index < lines.length && indentOf(lines[index]) === indent) {
        const raw = lines[index].trim();
        if (raw.startsWith("- ")) break;
        const colon = raw.indexOf(":");
        const key = raw.slice(0, colon).trim();
        const val = raw.slice(colon + 1).trim();
        index += 1;
        map[key] = val ? parseScalar(val) : parseBlock(indent + 1);
      }
      return map;
    }

    const config = parseBlock(0);
    config.timezone = config.timezone || "Asia/Seoul";
    config.lookahead_days = 35;
    config.alerts_enabled = config.alerts_enabled !== false;
    config.sleep = config.sleep || { start: "02:00", end: "02:00" };
    config.presets = config.presets || [];
    config.watches = (config.watches || []).map(normalizeWatch);
    config.booking_groups = normalizeGroups(config.booking_groups);
    return config;
  }

  function normalizeRelease(value) {
    if (value === undefined || value === null) return "09:00";
    const text = String(value).trim();
    if (!text) return "";
    const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(text);
    if (!match) return "09:00";
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return "09:00";
    return `${match[1]}:${match[2]}`;
  }

  function prepareConfigForSave(config) {
    const next = {
      timezone: config.timezone || "Asia/Seoul",
      lookahead_days: 35,
      alerts_enabled: config.alerts_enabled !== false,
      sleep: {
        start: (config.sleep && config.sleep.start) || "02:00",
        end: (config.sleep && config.sleep.end) || "02:00",
      },
      presets: Array.isArray(config.presets) ? config.presets : [],
      booking_groups: normalizeGroups(config.booking_groups),
      watches: (config.watches || []).map((watch) => {
        const normalized = normalizeWatch(watch);
        normalized.extras = pruneEmptyExtras(normalized.extras);
        return normalized;
      }),
    };
    return JSON.parse(JSON.stringify(next));
  }

  function defaultGroups() {
    return [
      {
        id: "stadium",
        name: "양산종합운동장",
        courts: [73],
        after_days: 2,
        days: 29,
        release: "09:00",
        open: "06:00",
        close: "22:00",
      },
      {
        id: "sapryang",
        name: "삽량체육공원",
        courts: [47, 64, 66, 67],
        after_days: 1,
        days: 30,
        release: "09:00",
        open: "08:00",
        close: "22:00",
      },
    ];
  }

  function normalizeGroups(groups) {
    if (!Array.isArray(groups) || !groups.length) return defaultGroups();
    return groups.map((group, index) => ({
      id: group.id || "group" + (index + 1),
      name: group.name || group.id || "예약",
      courts: (group.courts || []).map(Number),
      after_days: clamp(group.after_days, 0, 60, 0),
      days: clamp(group.days, 1, 60, 1),
      release: normalizeRelease(group.release),
      open: group.open || "06:00",
      close: group.close || "22:00",
    }));
  }

  function normalizeExtra(extra) {
    const next = { ...(extra || {}) };
    next.label = String(next.label || "").trim();
    next.weekdays = [...new Set((next.weekdays || []).map(Number).filter((day) => day >= 0 && day <= 6))].sort(
      (a, b) => a - b
    );
    next.dates = [...new Set((next.dates || []).map(String).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))].sort();
    next.slots = [...new Set((next.slots || []).map(String))].sort();
    next.replace = Boolean(next.replace);
    return next;
  }

  function pruneEmptyExtras(extras) {
    return (extras || [])
      .map(normalizeExtra)
      .filter(
        (extra) =>
          extra.label || extra.weekdays.length || extra.dates.length || extra.slots.length
      );
  }

  function normalizeWatch(watch) {
    const next = { ...(watch || {}) };
    next.id = Number(next.id);
    next.enabled = next.enabled !== false;
    next.open = next.open || "06:00";
    next.close = next.close || "22:00";
    const hasSplit =
      Object.prototype.hasOwnProperty.call(next, "weekday_slots") ||
      Object.prototype.hasOwnProperty.call(next, "weekend_slots");
    if (!hasSplit) {
      const days = new Set((next.weekdays || []).map(Number));
      const slots = [...(next.slots || [])];
      const weekdayDays = [0, 1, 2, 3, 4].filter((day) => days.has(day));
      const weekendDays = [5, 6].filter((day) => days.has(day));
      next.weekday_slots = weekdayDays.length ? slots : [];
      next.weekend_slots = weekendDays.length ? slots : [];
    } else {
      next.weekday_slots = [...(next.weekday_slots || [])];
      next.weekend_slots = [...(next.weekend_slots || [])];
    }
    const rawExtras = Array.isArray(next.extras) ? next.extras : [];
    next.extras = rawExtras.map(normalizeExtra);
    const weekdays = [];
    if ((next.weekday_slots || []).length) weekdays.push(0, 1, 2, 3, 4);
    if ((next.weekend_slots || []).length) weekdays.push(5, 6);
    next.extras.forEach((extra) => weekdays.push(...extra.weekdays));
    next.weekdays = [...new Set(weekdays)].sort((a, b) => a - b);
    const allSlots = [
      ...(next.weekday_slots || []),
      ...(next.weekend_slots || []),
      ...next.extras.flatMap((extra) => extra.slots),
    ];
    next.slots = [...new Set(allSlots)].sort();
    return next;
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function quote(value) {
    return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function dumpFlow(list) {
    return (
      "[" +
      list
        .map((item) => (typeof item === "number" ? String(item) : quote(item)))
        .join(", ") +
      "]"
    );
  }

  function dumpConfig(config) {
    const lines = [
      `timezone: ${config.timezone || "Asia/Seoul"}`,
      `lookahead_days: 35`,
      `alerts_enabled: ${config.alerts_enabled === false ? "false" : "true"}`,
      "sleep:",
      `  start: ${quote((config.sleep || {}).start || "02:00")}`,
      `  end: ${quote((config.sleep || {}).end || "02:00")}`,
      "presets:",
    ];
    (config.presets || []).forEach((preset) => {
      lines.push(`  - id: ${preset.id}`);
      lines.push(`    label: ${quote(preset.label || preset.id)}`);
      lines.push(`    weekdays: ${dumpFlow((preset.weekdays || []).map(Number))}`);
      lines.push(`    slots: ${dumpFlow(preset.slots || [])}`);
    });
    lines.push("booking_groups:");
    normalizeGroups(config.booking_groups).forEach((group) => {
      lines.push(`  - id: ${group.id}`);
      lines.push(`    name: ${quote(group.name || group.id)}`);
      lines.push(`    courts: ${dumpFlow((group.courts || []).map(Number))}`);
      lines.push(`    after_days: ${group.after_days}`);
      lines.push(`    days: ${group.days}`);
      lines.push(`    release: ${quote(group.release || "")}`);
      lines.push(`    open: ${quote(group.open || "06:00")}`);
      lines.push(`    close: ${quote(group.close || "22:00")}`);
    });
    lines.push("watches:");
    (config.watches || []).map(normalizeWatch).forEach((watch) => {
      const extras = pruneEmptyExtras(watch.extras);
      const fields = [
        `id: ${Number(watch.id)}`,
        `name: ${quote(watch.name || "")}`,
        `url: ${quote(watch.url || "")}`,
        `enabled: ${watch.enabled === false ? "false" : "true"}`,
        `open: ${quote(watch.open || "06:00")}`,
        `close: ${quote(watch.close || "22:00")}`,
        `weekdays: ${dumpFlow((watch.weekdays || []).map(Number))}`,
        `slots: ${dumpFlow(watch.slots || [])}`,
        `weekday_slots: ${dumpFlow(watch.weekday_slots || [])}`,
        `weekend_slots: ${dumpFlow(watch.weekend_slots || [])}`,
      ];
      fields.forEach((field, index) => {
        lines.push((index === 0 ? "  - " : "    ") + field);
      });
      if (extras.length) {
        lines.push("    extras:");
        extras.forEach((extra) => {
          lines.push(`      - label: ${quote(extra.label || "")}`);
          lines.push(`        weekdays: ${dumpFlow((extra.weekdays || []).map(Number))}`);
          lines.push(`        dates: ${dumpFlow(extra.dates || [])}`);
          lines.push(`        slots: ${dumpFlow(extra.slots || [])}`);
          lines.push(`        replace: ${extra.replace ? "true" : "false"}`);
        });
      }
    });
    return lines.join("\n") + "\n";
  }

  function hmToMinutes(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(value || "");
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  function menuSlots(openHm, closeHm) {
    let start = hmToMinutes(openHm);
    let end = hmToMinutes(closeHm);
    if (start === null) start = 6 * 60;
    if (end === null) end = 22 * 60;
    start = Math.max(start, 6 * 60);
    end = Math.min(end, 22 * 60);
    const slots = [];
    for (let cursor = start; cursor + 120 <= end; cursor += 120) {
      slots.push(`${formatHm(cursor)}-${formatHm(cursor + 120)}`);
    }
    return slots;
  }

  function formatHm(minutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function parseCourtAddress(text) {
    const raw = String(text || "").trim();
    if (/^\d{1,6}$/.test(raw)) {
      return { id: Number(raw), url: COURT_URL.replace("{id}", raw) };
    }
    const match = /(?:#\/|\/)(\d+)\/rent(?:\/step1)?(?:\b|$)/.exec(raw);
    if (!match) return null;
    return { id: Number(match[1]), url: COURT_URL.replace("{id}", match[1]) };
  }

  function defaultWatch(id, url, extras) {
    return normalizeWatch({
      id: id,
      name: `코트 ${id}`,
      url: url,
      enabled: true,
      open: (extras && extras.open) || "06:00",
      close: (extras && extras.close) || "22:00",
      weekday_slots: (extras && extras.weekday_slots) || ["20:00-22:00"],
      weekend_slots: (extras && extras.weekend_slots) || [],
      extras: (extras && extras.extras) || [],
    });
  }

  function formatWeekdays(days) {
    const ordered = [...new Set((days || []).map(Number))].sort((a, b) => a - b);
    if (ordered.join() === "0,1,2,3,4,5,6") return "매일";
    if (ordered.join() === "0,1,2,3,4") return "평일";
    if (ordered.join() === "5,6") return "주말";
    return ordered.filter((day) => day >= 0 && day <= 6).map((day) => WEEKDAYS[day]).join("");
  }

  return {
    WEEKDAYS,
    parseConfig,
    dumpConfig,
    menuSlots,
    parseCourtAddress,
    defaultWatch,
    normalizeGroups,
    normalizeWatch,
    normalizeExtra,
    pruneEmptyExtras,
    normalizeRelease,
    prepareConfigForSave,
    formatWeekdays,
    hmToMinutes,
  };
});
