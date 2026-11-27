const assert = require("assert");
const check = require("../web/check.js");

const today = "2026-11-22";
const config = {
  booking_groups: [
    { id: "stadium", courts: [73], after_days: 2, days: 29 },
    { id: "sapryang", courts: [47], after_days: 1, days: 30 },
  ],
  watches: [
    {
      id: 73,
      name: "실내테니스장 시민C코트",
      enabled: true,
      open: "06:00",
      close: "22:00",
      weekdays: [0, 1, 2, 3, 4],
      slots: ["20:00-22:00"],
    },
    {
      id: 47,
      name: "테니스장(3번)",
      enabled: true,
      open: "08:00",
      close: "22:00",
      weekdays: [0, 1, 2, 3, 4],
      slots: ["20:00-22:00", "06:00-08:00"],
    },
  ],
};

assert.strictEqual(check.isCheckCommand(" 체크 "), true);
assert.strictEqual(check.isCheckCommand("확인"), false);
assert.strictEqual(check.isCheckCommand("체크요"), false);

assert.strictEqual(check.weekdayIndex("2026-11-22"), 6);
assert.strictEqual(check.weekdayIndex("2026-11-23"), 0);

const stadium = check.bookingWindow(config, 73, today);
assert.deepStrictEqual(stadium, { start: "2026-11-24", end: "2026-12-22" });
const sapryang = check.bookingWindow(config, 47, today);
assert.deepStrictEqual(sapryang, { start: "2026-11-23", end: "2026-12-22" });
assert.strictEqual(check.bookingWindow(config, 80, today), null);
assert.deepStrictEqual(check.monthsCovering(stadium.start, stadium.end), ["2026-11", "2026-12"]);

const releaseConfig = {
  booking_groups: [{ courts: [47], after_days: 1, days: 30, release: "09:00" }],
};
assert.deepStrictEqual(check.bookingWindow(releaseConfig, 47, "2026-11-26", "08:59"), {
  start: "2026-11-27",
  end: "2026-12-25",
});
assert.deepStrictEqual(check.bookingWindow(releaseConfig, 47, "2026-11-26", "09:00"), {
  start: "2026-11-27",
  end: "2026-12-26",
});
assert.deepStrictEqual(check.bookingWindow(releaseConfig, 47, "2026-11-26"), {
  start: "2026-11-27",
  end: "2026-12-26",
});

assert.strictEqual(check.overlaps("20:00-22:00", "18:00", "21:00"), true);
assert.strictEqual(check.overlaps("20:00-22:00", "22:00", "24:00"), false);
assert.strictEqual(check.withinHours("06:00-08:00", "08:00", "22:00"), false);

const ranges = check.occupiedByDay([
  { state: "P", startTime: "2026-11-24 18:00", endTime: "2026-11-24 22:00" },
  { state: "C", startTime: "2026-11-25 20:00", endTime: "2026-11-25 22:00" },
  { state: "CR", startTime: "2026-11-26 20:00", endTime: "2026-11-26 22:00" },
  { state: "R", startTime: "2026-11-27 20:00", endTime: "2026-11-27 22:00" },
  { state: "N", startTime: "2026-11-30 20:00", endTime: "2026-11-30 22:00" },
  { state: "A", startTime: "2026-12-01 21:00", endTime: "2026-12-02 00:00", phoneNumber: "010-0000-0000" },
]);
assert.deepStrictEqual(ranges["2026-11-24"], [["18:00", "22:00"]]);
assert.strictEqual(ranges["2026-11-25"], undefined);
assert.strictEqual(ranges["2026-11-26"], undefined);
assert.strictEqual(ranges["2026-11-27"], undefined);
assert.deepStrictEqual(ranges["2026-11-30"], [["20:00", "22:00"]]);
assert.deepStrictEqual(ranges["2026-12-01"], [["21:00", "24:00"]]);
assert.strictEqual(JSON.stringify(ranges).includes("010"), false);

const rest = check.restDates([{ startDay: "2026-11-24", endDay: "2026-11-25" }]);
assert.strictEqual(rest.has("2026-11-24"), true);
assert.strictEqual(rest.has("2026-11-25"), true);
assert.strictEqual(rest.has("2026-11-26"), false);

const open = check.openKeys(
  config,
  {
    "73": { ranges, rest },
    "47": { ranges: {}, rest: new Set() },
  },
  today
);
assert.strictEqual(open.includes("73|2026-11-24|20:00-22:00"), false);
assert.strictEqual(open.includes("73|2026-11-25|20:00-22:00"), false);
assert.strictEqual(open.includes("73|2026-11-26|20:00-22:00"), true);
assert.strictEqual(open.includes("73|2026-11-28|20:00-22:00"), false);
assert.strictEqual(open.includes("73|2026-11-30|20:00-22:00"), false);
assert.strictEqual(open.includes("73|2026-12-01|20:00-22:00"), false);
assert.strictEqual(open.includes("73|2026-12-22|20:00-22:00"), true);
assert.strictEqual(open.includes("73|2026-12-23|20:00-22:00"), false);
assert.strictEqual(open.includes("47|2026-11-23|20:00-22:00"), true);
assert.strictEqual(open.includes("47|2026-11-23|06:00-08:00"), false);

const status = {
  initialized: true,
  slots: {
    "73|2026-11-26|20:00-22:00": false,
    "73|2026-12-22|20:00-22:00": true,
    "47|2026-11-23|20:00-22:00": false,
  },
};
const alarm = check.alarmKeys(status, open);
assert.strictEqual(alarm.comparable, true);
assert.deepStrictEqual(alarm.keys, ["73|2026-11-26|20:00-22:00", "47|2026-11-23|20:00-22:00"]);
assert.strictEqual(check.alarmKeys(null, open).comparable, false);
assert.deepStrictEqual(check.alarmKeys({ initialized: false, slots: status.slots }, open).keys, []);

const described = check.describe(config, ["73|2026-11-26|20:00-22:00"]);
assert.strictEqual(described[0].name, "실내테니스장 시민C코트");
assert.strictEqual(described[0].weekday, "목");
assert.strictEqual(described[0].slot, "20:00-22:00");

const weekend = check.openKeys(
  {
    booking_groups: [
      { id: "stadium", courts: [73], after_days: 0, days: 2 },
      { id: "sapryang", courts: [47], after_days: 0, days: 2 },
    ],
    watches: [
      {
        id: 73,
        enabled: true,
        open: "06:00",
        close: "22:00",
        weekday_slots: [],
        weekend_slots: ["18:00-20:00", "20:00-22:00"],
        extras: [{ weekdays: [6], slots: ["18:00-20:00"], replace: false }],
      },
      {
        id: 47,
        enabled: true,
        open: "06:00",
        close: "22:00",
        weekday_slots: [],
        saturday_slots: ["18:00-20:00"],
        sunday_slots: ["20:00-22:00"],
      },
    ],
  },
  {
    "73": { ranges: {}, rest: new Set() },
    "47": { ranges: {}, rest: new Set() },
  },
  "2026-11-21"
);
assert.strictEqual(weekend.includes("73|2026-11-21|18:00-20:00"), true);
assert.strictEqual(weekend.includes("73|2026-11-21|20:00-22:00"), true);
assert.strictEqual(weekend.includes("73|2026-11-22|18:00-20:00"), false);
assert.strictEqual(weekend.includes("73|2026-11-22|20:00-22:00"), true);
assert.strictEqual(weekend.includes("47|2026-11-21|18:00-20:00"), true);
assert.strictEqual(weekend.includes("47|2026-11-22|20:00-22:00"), true);
assert.strictEqual(weekend.includes("47|2026-11-22|18:00-20:00"), false);

console.log("web check ok");
