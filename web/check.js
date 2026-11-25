(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.CourtCheck = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];
  const HORIZON_DAYS = 35;
  const OCCUPIED = new Set(["N", "A", "P"]);
  const API = "https://www.yssisul.or.kr/rent/api";

  function isCheckCommand(text) {
    return String(text || "").trim().replace(/\s+/g, " ") === "체크";
  }

  function asInt(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
  }

  function addDays(iso, count) {
    const [year, month, day] = String(iso).split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + count));
    return next.toISOString().slice(0, 10);
  }

  function weekdayIndex(iso) {
    const [year, month, day] = String(iso).split("-").map(Number);
    const sunday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return (sunday + 6) % 7;
  }

  function bookingWindow(config, courtId, todayIso) {
    const groups = config.booking_groups || [];
    if (!groups.length) {
      return { start: todayIso, end: addDays(todayIso, HORIZON_DAYS - 1) };
    }
    for (const group of groups) {
      const courts = new Set((group.courts || []).map(String));
      if (!courts.has(String(courtId))) continue;
      const after = asInt(group.after_days, 0);
      const days = asInt(group.days, 0);
      if (after < 0 || days < 1) return null;
      const start = addDays(todayIso, after);
      return { start, end: addDays(start, days - 1) };
    }
    return null;
  }

  function monthsCovering(startIso, endIso) {
    const months = [];
    let cursor = String(startIso).slice(0, 7);
    const last = String(endIso).slice(0, 7);
    while (cursor <= last && months.length < 6) {
      months.push(cursor);
      const [year, month] = cursor.split("-").map(Number);
      cursor = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
    }
    return months;
  }

  function slotBounds(slot) {
    const parts = String(slot).split("-");
    if (parts.length !== 2 || !/^\d{2}:\d{2}$/.test(parts[0]) || !/^\d{2}:\d{2}$/.test(parts[1])) {
      return null;
    }
    if (parts[0] >= parts[1]) return null;
    return parts;
  }

  function withinHours(slot, openHm, closeHm) {
    const bounds = slotBounds(slot);
    if (!bounds || !/^\d{2}:\d{2}$/.test(openHm) || !/^\d{2}:\d{2}$/.test(closeHm)) return false;
    return bounds[0] >= openHm && bounds[1] <= closeHm;
  }

  function overlaps(slot, busyStart, busyEnd) {
    const bounds = slotBounds(slot);
    if (!bounds) return false;
    return bounds[0] < busyEnd && busyStart < bounds[1];
  }

  function dayOf(value) {
    const match = String(value || "").match(/(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
  }

  function hmOf(value) {
    const match = String(value || "").match(/(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : "";
  }

  function pushRange(byDay, day, start, end) {
    if (!day || !start || !end || start >= end) return;
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push([start, end]);
  }

  function occupiedByDay(reservations) {
    const byDay = {};
    (reservations || []).forEach((item) => {
      if (!OCCUPIED.has(String(item && item.state))) return;
      const startDay = dayOf(item.startTime);
      const endDay = dayOf(item.endTime) || startDay;
      const start = hmOf(item.startTime);
      const end = hmOf(item.endTime);
      if (!startDay || !start || !end) return;
      if (startDay === endDay) {
        pushRange(byDay, startDay, start, end);
        return;
      }
      pushRange(byDay, startDay, start, "24:00");
      if (end !== "00:00") pushRange(byDay, endDay, "00:00", end);
    });
    return byDay;
  }

  function restDates(rows) {
    const dates = new Set();
    (rows || []).forEach((row) => {
      const start = dayOf(row && row.startDay);
      const end = dayOf(row && row.endDay) || start;
      if (!start || end < start) return;
      let cursor = start;
      while (cursor <= end && dates.size < 400) {
        dates.add(cursor);
        cursor = addDays(cursor, 1);
      }
    });
    return dates;
  }

  function baseSlotsForDay(watch, weekday) {
    const hasSplit =
      Object.prototype.hasOwnProperty.call(watch, "weekday_slots") ||
      Object.prototype.hasOwnProperty.call(watch, "weekend_slots");
    if (hasSplit) {
      if (weekday < 5) return [...(watch.weekday_slots || [])].map(String);
      return [...(watch.weekend_slots || [])].map(String);
    }
    const weekdays = new Set((watch.weekdays || []).map(Number));
    if (!weekdays.has(weekday)) return [];
    return [...(watch.slots || [])].map(String);
  }

  function extraMatches(extra, weekday, dayIso) {
    const dates = new Set((extra.dates || []).map(String));
    const days = new Set((extra.weekdays || []).map(Number));
    if (dates.has(String(dayIso))) return true;
    if (days.size && days.has(weekday)) return true;
    return false;
  }

  function slotsForDay(watch, weekday, dayIso) {
    const base = baseSlotsForDay(watch, weekday);
    const extras = (watch.extras || []).filter((item) => item && typeof item === "object");
    if (!extras.length) return base;
    const matched = extras.filter((item) => extraMatches(item, weekday, dayIso || ""));
    if (!matched.length) return base;
    const add = [];
    const replace = [];
    let replaced = false;
    matched.forEach((extra) => {
      const slots = [...(extra.slots || [])].map(String);
      if (extra.replace) {
        replaced = true;
        replace.push(...slots);
      } else {
        add.push(...slots);
      }
    });
    if (replaced) return [...new Set([...replace, ...add])].sort();
    return [...new Set([...base, ...add])].sort();
  }

  function openKeys(config, calendars, todayIso) {
    const keys = [];
    (config.watches || []).forEach((watch) => {
      if (watch.enabled === false) return;
      const courtId = String(watch.id);
      const window = bookingWindow(config, courtId, todayIso);
      if (!window) return;
      const calendar = calendars[courtId] || {};
      const ranges = calendar.ranges || {};
      const rest = calendar.rest instanceof Set ? calendar.rest : new Set(calendar.rest || []);
      let cursor = window.start;
      while (cursor <= window.end) {
        const current = cursor;
        cursor = addDays(cursor, 1);
        const slots = slotsForDay(watch, weekdayIndex(current), current);
        slots.forEach((slot) => {
          if (!withinHours(slot, watch.open || "06:00", watch.close || "22:00")) return;
          if (rest.has(current)) return;
          const busy = (ranges[current] || []).some((range) => overlaps(slot, range[0], range[1]));
          if (!busy) keys.push(`${courtId}|${current}|${slot}`);
        });
      }
    });
    return keys;
  }

  function alarmKeys(status, keys) {
    if (!status) return { comparable: false, keys: [] };
    if (!status.initialized) return { comparable: true, keys: [] };
    const slots = status.slots || {};
    return {
      comparable: true,
      keys: keys.filter((key) => Object.prototype.hasOwnProperty.call(slots, key) && slots[key] === false),
    };
  }

  function describe(config, keys) {
    const names = {};
    (config.watches || []).forEach((watch) => {
      names[String(watch.id)] = String(watch.name || watch.id);
    });
    return keys.map((key) => {
      const parts = String(key).split("|");
      const courtId = parts[0];
      const day = parts[1];
      const slot = parts.slice(2).join("|");
      return {
        id: courtId,
        name: names[courtId] || courtId,
        day,
        weekday: WEEKDAYS[weekdayIndex(day)] || "",
        slot,
      };
    });
  }

  function asList(value) {
    return Array.isArray(value) ? value : [];
  }

  async function fetchJson(fetcher, url) {
    const response = await fetcher(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("예약 정보를 읽지 못했습니다");
    return response.json();
  }

  async function loadPreview(config, status, todayIso, fetchImpl) {
    const fetcher = fetchImpl || fetch;
    const calendars = {};
    const watches = (config.watches || []).filter((watch) => watch.enabled !== false);
    await Promise.all(
      watches.map(async (watch) => {
        const courtId = String(watch.id);
        const window = bookingWindow(config, courtId, todayIso);
        if (!window) return;
        const reservations = [];
        const rests = [];
        for (const month of monthsCovering(window.start, window.end)) {
          const [rent, rest] = await Promise.all([
            fetchJson(fetcher, `${API}/rent?facility=${encodeURIComponent(courtId)}&month=${month}`),
            fetchJson(fetcher, `${API}/restday?facility=${encodeURIComponent(courtId)}&month=${month}`),
          ]);
          asList(rent).forEach((item) => {
            reservations.push({
              state: item && item.state,
              startTime: item && item.startTime,
              endTime: item && item.endTime,
            });
          });
          asList(rest).forEach((item) => {
            rests.push({ startDay: item && item.startDay, endDay: item && item.endDay });
          });
        }
        calendars[courtId] = { ranges: occupiedByDay(reservations), rest: restDates(rests) };
      })
    );
    const open = openKeys(config, calendars, todayIso);
    return { open, alarm: alarmKeys(status, open) };
  }

  return {
    WEEKDAYS,
    isCheckCommand,
    addDays,
    weekdayIndex,
    bookingWindow,
    monthsCovering,
    withinHours,
    overlaps,
    occupiedByDay,
    restDates,
    openKeys,
    alarmKeys,
    describe,
    loadPreview,
  };
});
