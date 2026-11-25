import json
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from checker.config_store import load_config, save_config
from checker.logic import (
    acknowledge,
    booking_window,
    collect_alerts,
    crawl_end,
    failure_should_send,
    forget_courts,
    format_weekdays,
    fresh_state,
    needs_state_save,
    in_sleep,
    is_status_command,
    observed_slots,
    overlaps,
    parse_event_titles,
    render_alert,
    render_open_now,
    within_hours,
)
from checker.settings import apply_callback, apply_text, parse_court_address


class SleepTests(unittest.TestCase):
    def test_same_times_mean_no_sleep(self):
        now = datetime(2026, 11, 14, 3, 0, tzinfo=ZoneInfo("Asia/Seoul"))
        self.assertFalse(in_sleep(now, "02:00", "02:00"))

    def test_window_and_overnight(self):
        seoul = ZoneInfo("Asia/Seoul")
        self.assertTrue(in_sleep(datetime(2026, 11, 14, 2, 0, tzinfo=seoul), "02:00", "06:00"))
        self.assertFalse(in_sleep(datetime(2026, 11, 14, 6, 0, tzinfo=seoul), "02:00", "06:00"))
        self.assertTrue(in_sleep(datetime(2026, 11, 14, 23, 30, tzinfo=seoul), "23:00", "07:00"))
        self.assertTrue(in_sleep(datetime(2026, 11, 14, 1, 0, tzinfo=seoul), "23:00", "07:00"))
        self.assertFalse(in_sleep(datetime(2026, 11, 14, 12, 0, tzinfo=seoul), "23:00", "07:00"))


class CheckTimeTests(unittest.TestCase):
    def test_same_slots_still_save_when_time_changes(self):
        previous = fresh_state()
        previous["initialized"] = True
        previous["last_check"] = "2026-11-22 10:12:00"
        previous["slots"] = {"73|2026-11-23|20:00-22:00": False}
        current = json.loads(json.dumps(previous))
        current["last_check"] = "2026-11-22 10:13:04"
        self.assertTrue(needs_state_save(previous, current))

    def test_unchanged_state_does_not_save(self):
        previous = fresh_state()
        previous["last_check"] = "2026-11-22 10:12:00"
        self.assertFalse(needs_state_save(previous, json.loads(json.dumps(previous))))


class ParseTests(unittest.TestCase):
    def test_occupied_rest_and_cancelled(self):
        rest, ranges = parse_event_titles(
            [
                "[신청]18:00 ~ 20:00 클럽(홍*동)",
                "[취소]10:00 ~ 12:00 취소팀",
                "[휴관] 정기휴관",
            ]
        )
        self.assertTrue(rest)
        self.assertEqual(ranges, [("18:00", "20:00")])

    def test_overlap_edges(self):
        self.assertTrue(overlaps("18:00-20:00", "19:00", "21:00"))
        self.assertFalse(overlaps("18:00-20:00", "20:00", "22:00"))
        self.assertTrue(within_hours("18:00-20:00", "08:00", "22:00"))
        self.assertFalse(within_hours("06:00-08:00", "08:00", "22:00"))


class AlertTests(unittest.TestCase):
    def test_first_run_is_baseline(self):
        state = fresh_state()
        sent = collect_alerts(state, {"73|2026-11-20|18:00-20:00": True}, False, "2026-11-14")
        self.assertEqual(sent, [])
        self.assertTrue(state["initialized"])
        self.assertTrue(state["slots"]["73|2026-11-20|18:00-20:00"])

    def test_edge_and_repeat_and_reopen(self):
        state = fresh_state()
        state["initialized"] = True
        key = "73|2026-11-20|18:00-20:00"
        sent = collect_alerts(state, {key: True}, False, "2026-11-14")
        self.assertEqual(sent, [])
        state["slots"][key] = False
        sent = collect_alerts(state, {key: True}, False, "2026-11-14")
        self.assertEqual(sent, [key])
        acknowledge(state, sent)
        sent = collect_alerts(state, {key: True}, False, "2026-11-14")
        self.assertEqual(sent, [])
        collect_alerts(state, {key: False}, False, "2026-11-14")
        sent = collect_alerts(state, {key: True}, False, "2026-11-14")
        self.assertEqual(sent, [key])

    def test_muted_queues_until_later(self):
        state = fresh_state()
        state["initialized"] = True
        key = "73|2026-11-20|18:00-20:00"
        state["slots"][key] = False
        sent = collect_alerts(state, {key: True}, True, "2026-11-14")
        self.assertEqual(sent, [])
        self.assertIn(key, state["pending"])
        sent = collect_alerts(state, {key: True}, False, "2026-11-14")
        self.assertEqual(sent, [key])
        acknowledge(state, sent)
        self.assertNotIn(key, state["pending"])

    def test_muted_reopen_is_queued_once(self):
        state = fresh_state()
        state["initialized"] = True
        key = "73|2026-11-20|18:00-20:00"
        state["slots"][key] = True
        collect_alerts(state, {key: False}, True, "2026-11-14")
        collect_alerts(state, {key: True}, True, "2026-11-14")
        self.assertEqual(state["pending"], [key])
        sent = collect_alerts(state, {key: False}, False, "2026-11-14")
        self.assertEqual(sent, [])

    def test_failed_send_can_retry(self):
        state = fresh_state()
        state["initialized"] = True
        key = "73|2026-11-20|18:00-20:00"
        state["slots"][key] = False
        sent = collect_alerts(state, {key: True}, False, "2026-11-14")
        self.assertEqual(sent, [key])
        sent_again = collect_alerts(state, {key: True}, False, "2026-11-14")
        self.assertEqual(sent_again, [key])

    def test_message_groups_courts(self):
        config = {
            "watches": [
                {"id": 73, "name": "시민C https://example.test/73", "url": "https://example.test/73"},
                {"id": 47, "name": "3번", "url": "https://example.test/47"},
            ]
        }
        text = render_alert(
            config,
            [
                "47|2026-11-21|20:00-22:00",
                "73|2026-11-20|18:00-20:00",
                "73|2026-11-20|18:00-20:00",
            ],
        )
        self.assertIn("시민C", text)
        self.assertIn("2026-11-20 (금) 18:00-20:00", text)
        self.assertLess(text.index("시민C"), text.index("3번"))
        self.assertTrue(text.endswith("먼저 예약될 수 있습니다"))
        self.assertNotIn("http", text)
        self.assertNotIn("example.test", text)

    def test_failure_is_once_until_recovery(self):
        state = fresh_state()
        self.assertFalse(failure_should_send(state, True))
        self.assertTrue(state["failure_pending"])
        self.assertTrue(failure_should_send(state, False))
        from checker.logic import acknowledge_failure, note_recovery

        acknowledge_failure(state)
        self.assertFalse(failure_should_send(state, False))
        note_recovery(state)
        self.assertTrue(failure_should_send(state, False))


class CalendarTests(unittest.TestCase):
    def test_grey_rest_and_weekday_filters(self):
        config = {
            "lookahead_days": 2,
            "watches": [
                {
                    "id": 73,
                    "enabled": True,
                    "open": "06:00",
                    "close": "22:00",
                    "weekdays": [4],
                    "slots": ["18:00-20:00", "06:00-08:00"],
                }
            ],
        }
        friday = date(2026, 11, 13)
        calendars = {
            "73": {
                "2026-11-13": {"grey": False, "rest": False, "ranges": [("18:00", "20:00")]},
                "2026-11-14": {"grey": True, "rest": False, "ranges": []},
            }
        }
        observed = observed_slots(config, calendars, friday)
        self.assertFalse(observed["73|2026-11-13|18:00-20:00"])
        self.assertTrue(observed["73|2026-11-13|06:00-08:00"])
        self.assertNotIn("73|2026-11-14|18:00-20:00", observed)

    def test_missing_day_is_not_treated_as_open(self):
        config = {
            "lookahead_days": 1,
            "watches": [
                {
                    "id": 47,
                    "enabled": True,
                    "open": "08:00",
                    "close": "22:00",
                    "weekdays": [5],
                    "slots": ["18:00-20:00"],
                }
            ],
        }
        self.assertEqual(observed_slots(config, {"47": {}}, date(2026, 11, 14)), {})

    def test_weekday_and_weekend_slots_differ(self):
        friday = date(2026, 11, 20)
        saturday = date(2026, 11, 21)
        config = {
            "booking_groups": [{"courts": [73], "after_days": 0, "days": 2}],
            "watches": [
                {
                    "id": 73,
                    "enabled": True,
                    "open": "06:00",
                    "close": "22:00",
                    "weekday_slots": ["20:00-22:00"],
                    "weekend_slots": ["08:00-10:00"],
                }
            ],
        }
        calendars = {"73": _open_days(friday, saturday)}
        observed = observed_slots(config, calendars, friday)
        self.assertTrue(observed["73|2026-11-20|20:00-22:00"])
        self.assertNotIn("73|2026-11-20|08:00-10:00", observed)
        self.assertTrue(observed["73|2026-11-21|08:00-10:00"])
        self.assertNotIn("73|2026-11-21|20:00-22:00", observed)

    def test_extra_slots_add_and_replace(self):
        friday = date(2026, 11, 20)
        wednesday = date(2026, 11, 18)
        config = {
            "booking_groups": [{"courts": [73], "after_days": 0, "days": 5}],
            "watches": [
                {
                    "id": 73,
                    "enabled": True,
                    "open": "06:00",
                    "close": "22:00",
                    "weekday_slots": ["20:00-22:00"],
                    "weekend_slots": [],
                    "extras": [
                        {
                            "weekdays": [2],
                            "dates": [],
                            "slots": ["18:00-20:00"],
                            "replace": False,
                        },
                        {
                            "weekdays": [],
                            "dates": ["2026-11-20"],
                            "slots": ["10:00-12:00"],
                            "replace": True,
                        },
                    ],
                }
            ],
        }
        calendars = {"73": _open_days(wednesday, friday)}
        observed = observed_slots(config, calendars, wednesday)
        self.assertTrue(observed["73|2026-11-18|20:00-22:00"])
        self.assertTrue(observed["73|2026-11-18|18:00-20:00"])
        self.assertTrue(observed["73|2026-11-20|10:00-12:00"])
        self.assertNotIn("73|2026-11-20|20:00-22:00", observed)

    def test_booking_groups_limit_each_court(self):
        today = date(2026, 11, 15)
        config = {
            "booking_groups": [
                {"id": "stadium", "courts": [73], "after_days": 2, "days": 14},
                {"id": "sapryang", "courts": [47, 64, 66, 67], "after_days": 1, "days": 15},
            ],
            "watches": [
                {
                    "id": 73,
                    "enabled": True,
                    "open": "06:00",
                    "close": "22:00",
                    "weekdays": list(range(7)),
                    "slots": ["20:00-22:00"],
                },
                {
                    "id": 47,
                    "enabled": True,
                    "open": "08:00",
                    "close": "22:00",
                    "weekdays": list(range(7)),
                    "slots": ["20:00-22:00"],
                },
            ],
        }
        calendars = {
            "73": _open_days(date(2026, 11, 15), date(2026, 12, 5)),
            "47": _open_days(date(2026, 11, 15), date(2026, 12, 5)),
        }
        observed = observed_slots(config, calendars, today)
        self.assertEqual(booking_window(config, 73, today), (date(2026, 11, 17), date(2026, 11, 30)))
        self.assertEqual(booking_window(config, 47, today), (date(2026, 11, 16), date(2026, 11, 30)))
        self.assertEqual(crawl_end(config, today), date(2026, 11, 30))
        self.assertNotIn("73|2026-11-16|20:00-22:00", observed)
        self.assertTrue(observed["73|2026-11-17|20:00-22:00"])
        self.assertTrue(observed["73|2026-11-30|20:00-22:00"])
        self.assertNotIn("73|2026-12-01|20:00-22:00", observed)
        self.assertNotIn("47|2026-11-15|20:00-22:00", observed)
        self.assertTrue(observed["47|2026-11-16|20:00-22:00"])
        self.assertTrue(observed["47|2026-11-30|20:00-22:00"])
        self.assertNotIn("47|2026-12-01|20:00-22:00", observed)

    def test_status_command_is_exact(self):
        self.assertTrue(is_status_command("", "확인"))
        self.assertTrue(is_status_command("확인", ""))
        self.assertTrue(is_status_command("", "체크"))
        self.assertTrue(is_status_command("체크", ""))
        self.assertFalse(is_status_command("", "체크요"))
        self.assertFalse(is_status_command("지금 빈 시간", "지금 빈 시간이 없습니다."))
        self.assertFalse(is_status_command("코트 감시 실패", "예약 화면을 읽지 못했습니다. 다음 검사에서 다시 확인합니다."))
        text = render_open_now(
            {"watches": [{"id": 73, "name": "시민C"}]},
            ["73|2026-11-17|20:00-22:00"],
        )
        self.assertTrue(text.startswith("지금 빈 시간"))
        self.assertIn("2026-11-17 (화) 20:00-22:00", text)
        self.assertNotIn("http", text)


def _open_days(start: date, end: date) -> dict:
    days = {}
    current = start
    while current <= end:
        days[current.isoformat()] = {"grey": False, "rest": False, "ranges": []}
        current += timedelta(days=1)
    return days


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "alerts_enabled": True,
            "lookahead_days": 14,
            "sleep": {"start": "02:00", "end": "06:00"},
            "presets": [
                {
                    "id": "eve",
                    "label": "평일 저녁",
                    "weekdays": [0, 1, 2, 3, 4],
                    "slots": ["18:00-20:00", "20:00-22:00"],
                }
            ],
            "watches": [
                {
                    "id": 73,
                    "name": "시민C",
                    "enabled": True,
                    "open": "06:00",
                    "close": "22:00",
                    "weekdays": [0, 1, 2, 3, 4],
                    "slots": ["18:00-20:00"],
                }
            ],
        }
        self.state = fresh_state()

    def test_other_actions_are_absolute(self):
        text, _markup, changed, test = apply_callback(self.config, self.state, "ce:73:0")
        self.assertTrue(changed)
        self.assertFalse(test)
        self.assertFalse(self.config["watches"][0]["enabled"])
        apply_callback(self.config, self.state, "ce:73:0")
        self.assertFalse(self.config["watches"][0]["enabled"])
        self.assertIn("껐습니다", text)

    def test_slot_preset_sleep_and_days(self):
        apply_callback(self.config, self.state, "ts:73:20:1")
        self.assertIn("20:00-22:00", self.config["watches"][0]["slots"])
        apply_callback(self.config, self.state, "ps:73:eve")
        self.assertEqual(self.config["watches"][0]["slots"], ["18:00-20:00", "20:00-22:00"])
        self.assertEqual(self.config["watches"][0]["weekdays"], [0, 1, 2, 3, 4])
        apply_callback(self.config, self.state, "ss:2307")
        self.assertEqual(self.config["sleep"], {"start": "23:00", "end": "07:00"})
        apply_text(self.config, self.state, "00:30-08:15")
        self.assertIsNone(self.state["awaiting"])
        apply_callback(self.config, self.state, "ss:ask")
        text, _markup, changed, _test = apply_text(self.config, self.state, "23:30 07:10")
        self.assertTrue(changed)
        self.assertEqual(self.config["sleep"]["start"], "23:30")
        self.assertIn("23:30-07:10", text)
        apply_callback(self.config, self.state, "dy:7")
        self.assertEqual(self.config["lookahead_days"], 7)
        apply_callback(self.config, self.state, "al:0")
        self.assertFalse(self.config["alerts_enabled"])
        self.assertEqual(format_weekdays([0, 1, 2, 3, 4]), "평일")

    def test_address_can_be_added_changed_and_removed(self):
        self.assertEqual(
            parse_court_address("https://www.yssisul.or.kr/rent/#/80/rent/step1"),
            (80, "https://www.yssisul.or.kr/rent/#/80/rent/step1"),
        )
        self.assertEqual(parse_court_address("80")[0], 80)
        self.state["slots"]["73|2026-11-20|18:00-20:00"] = True
        self.state["open_now"] = ["73|2026-11-20|18:00-20:00"]
        apply_callback(self.config, self.state, "uu:73")
        text, _markup, changed, _test = apply_text(
            self.config,
            self.state,
            "https://www.yssisul.or.kr/rent/#/80/rent/step1",
        )
        self.assertTrue(changed)
        self.assertEqual(self.config["watches"][0]["id"], 80)
        self.assertIn("/80/", self.config["watches"][0]["url"])
        self.assertIn("저장했습니다", text)
        self.assertEqual(self.state["slots"], {})
        apply_callback(self.config, self.state, "ua")
        text, _markup, changed, _test = apply_text(self.config, self.state, "47")
        self.assertTrue(changed)
        self.assertEqual(self.config["watches"][1]["id"], 47)
        self.assertIn("추가했습니다", text)
        apply_text(self.config, self.state, "47")
        forget_courts(self.state, set())
        apply_callback(self.config, self.state, "ud:47")
        self.assertEqual([watch["id"] for watch in self.config["watches"]], [80])

    def test_yaml_keeps_clock_strings(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.yaml"
            save_config(path, self.config)
            loaded = load_config(path)
            saved = path.read_text(encoding="utf-8")
        self.assertEqual(loaded["sleep"]["start"], "02:00")
        self.assertIn('"02:00"', saved)
        self.assertIsInstance(loaded["watches"][0]["id"], int)
        self.assertEqual(loaded["watches"][0]["slots"], ["18:00-20:00"])


if __name__ == "__main__":
    unittest.main()
