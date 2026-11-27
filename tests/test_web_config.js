const fs = require("fs");
const path = require("path");
const assert = require("assert");
const configApi = require("../web/config.js");

const source = fs.readFileSync(path.join(__dirname, "..", "config.yaml"), "utf8");
const config = configApi.parseConfig(source);
assert.strictEqual(config.sleep.start, "02:00");
assert.strictEqual(config.sleep.end, "06:00");
assert.strictEqual(config.lookahead_days, 35);
assert.strictEqual(config.alerts_enabled, true);
assert.strictEqual(config.watches.length, 5);
assert.strictEqual(config.watches[0].id, 73);
assert.deepStrictEqual(config.watches[0].weekday_slots, ["20:00-22:00"]);
assert.deepStrictEqual(config.watches[0].weekend_slots, []);
assert.deepStrictEqual(config.watches[0].saturday_slots, []);
assert.deepStrictEqual(config.watches[0].sunday_slots, []);
assert.deepStrictEqual(config.booking_groups[0].closed_slots, [{ weekdays: [6], slots: ["20:00-22:00"] }]);
assert.strictEqual(config.booking_groups[0].after_days, 2);
assert.strictEqual(config.booking_groups[0].days, 29);
assert.strictEqual(config.booking_groups[0].release, "09:00");
assert.strictEqual(config.booking_groups[0].open, "06:00");
assert.strictEqual(config.booking_groups[1].after_days, 1);
assert.strictEqual(config.booking_groups[1].days, 30);
assert.strictEqual(config.booking_groups[1].release, "09:00");
assert.strictEqual(config.booking_groups[1].open, "08:00");
assert.deepStrictEqual(config.presets, []);

const again = configApi.parseConfig(configApi.dumpConfig(config));
assert.deepStrictEqual(again.booking_groups[1].courts, config.booking_groups[1].courts);
assert.strictEqual(again.booking_groups[0].release, "09:00");
assert.strictEqual(again.watches[4].url, config.watches[4].url);
assert.deepStrictEqual(again.watches[0].weekday_slots, config.watches[0].weekday_slots);
assert.deepStrictEqual(again.watches[0].weekend_slots, config.watches[0].weekend_slots);
assert.deepStrictEqual(again.watches[0].sunday_slots, []);
assert.deepStrictEqual(again.booking_groups[0].closed_slots, config.booking_groups[0].closed_slots);

const normalized = configApi.normalizeGroups([{ id: "x", courts: [1], after_days: 0, days: 1 }]);
assert.strictEqual(normalized[0].release, "09:00");
const blank = configApi.normalizeGroups([
  { id: "x", courts: [1], after_days: 0, days: 1, release: "" },
]);
assert.strictEqual(blank[0].release, "");
assert.strictEqual(configApi.normalizeRelease("09:00:00"), "09:00");
const stadium = configApi.normalizeGroups([{ id: "stadium", courts: [73], after_days: 2, days: 29 }]);
assert.deepStrictEqual(stadium[0].closed_slots, [{ weekdays: [6], slots: ["20:00-22:00"] }]);
assert.strictEqual(configApi.weekendSplit(stadium[0]), true);
assert.strictEqual(configApi.offeredSlots(stadium[0], [6]).includes("20:00-22:00"), false);
assert.strictEqual(configApi.offeredSlots(stadium[0], [6]).includes("18:00-20:00"), true);
assert.strictEqual(configApi.offeredSlots(stadium[0], [5]).includes("20:00-22:00"), true);
assert.strictEqual(configApi.weekendSplit(config.booking_groups[1]), false);
const scrubbed = configApi.scrubClosedSlots({
  booking_groups: [{ id: "stadium", courts: [73], after_days: 2, days: 29 }],
  watches: [{
    id: 73,
    weekday_slots: ["20:00-22:00"],
    weekend_slots: ["18:00-20:00", "20:00-22:00"],
    extras: [{ weekdays: [6], dates: [], slots: ["20:00-22:00"], replace: false }],
  }],
});
assert.deepStrictEqual(scrubbed.watches[0].saturday_slots, ["18:00-20:00", "20:00-22:00"]);
assert.deepStrictEqual(scrubbed.watches[0].sunday_slots, ["18:00-20:00"]);
assert.deepStrictEqual(scrubbed.watches[0].extras[0].slots, []);
const migrated = configApi.normalizeGroups([{
  id: "stadium",
  courts: [73],
  after_days: 2,
  days: 29,
  closed_slots: [{ weekdays: [6], slots: ["18:00-20:00"] }],
}]);
assert.deepStrictEqual(migrated[0].closed_slots, [{ weekdays: [6], slots: ["20:00-22:00"] }]);
const kept = configApi.normalizeGroups([{ id: "stadium", courts: [73], after_days: 2, days: 29, closed_slots: [] }]);
assert.deepStrictEqual(kept[0].closed_slots, []);
const prepared = configApi.prepareConfigForSave({
  booking_groups: [{ id: "stadium", courts: [73], after_days: 2, days: 29 }],
  watches: [{ id: 73, name: "C", url: "https://example.test/73" }],
});
assert.strictEqual(prepared.booking_groups[0].release, "09:00");
assert.strictEqual(Object.prototype.hasOwnProperty.call(prepared.booking_groups[0], "release"), true);

assert.deepStrictEqual(configApi.menuSlots("08:00", "22:00").slice(0, 2), ["08:00-10:00", "10:00-12:00"]);
assert.strictEqual(configApi.parseCourtAddress("73").id, 73);
assert.strictEqual(
  configApi.parseCourtAddress("https://www.yssisul.or.kr/rent/#/80/rent/step1").url,
  "https://www.yssisul.or.kr/rent/#/80/rent/step1"
);

console.log("web config ok");
