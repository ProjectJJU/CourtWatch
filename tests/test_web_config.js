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
assert.strictEqual(config.booking_groups[0].after_days, 2);
assert.strictEqual(config.booking_groups[0].days, 29);
assert.strictEqual(config.booking_groups[0].open, "06:00");
assert.strictEqual(config.booking_groups[1].after_days, 1);
assert.strictEqual(config.booking_groups[1].days, 30);
assert.strictEqual(config.booking_groups[1].open, "08:00");
assert.deepStrictEqual(config.presets, []);

const again = configApi.parseConfig(configApi.dumpConfig(config));
assert.deepStrictEqual(again.booking_groups[1].courts, config.booking_groups[1].courts);
assert.strictEqual(again.watches[4].url, config.watches[4].url);
assert.deepStrictEqual(again.watches[0].weekday_slots, config.watches[0].weekday_slots);
assert.deepStrictEqual(again.watches[0].weekend_slots, config.watches[0].weekend_slots);

assert.deepStrictEqual(configApi.menuSlots("08:00", "22:00").slice(0, 2), ["08:00-10:00", "10:00-12:00"]);
assert.strictEqual(configApi.parseCourtAddress("73").id, 73);
assert.strictEqual(
  configApi.parseCourtAddress("https://www.yssisul.or.kr/rent/#/80/rent/step1").url,
  "https://www.yssisul.or.kr/rent/#/80/rent/step1"
);

console.log("web config ok");
