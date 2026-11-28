import unittest
from datetime import date

from checker.crawl import CrawlError, calendar_days, crawl_courts, months_covering, occupied_by_day
from checker.logic import observed_slots


class CalendarTests(unittest.TestCase):
    def test_months_cover_the_window(self):
        self.assertEqual(months_covering(date(2026, 11, 23), date(2026, 12, 22)), ["2026-11", "2026-12"])

    def test_occupied_and_rest_days(self):
        days = calendar_days(
            date(2026, 11, 23),
            date(2026, 11, 24),
            [{"state": "P", "startTime": "2026-11-23 20:00", "endTime": "2026-11-23 22:00"}],
            [{"startDay": "2026-11-24", "endDay": "2026-11-24"}],
        )
        self.assertEqual(days["2026-11-23"]["ranges"], [("20:00", "22:00")])
        self.assertTrue(days["2026-11-24"]["rest"])
        self.assertEqual(occupied_by_day([{"state": "X", "startTime": "2026-11-23 20:00", "endTime": "2026-11-23 22:00"}]), {})

    def test_courts_are_read_together(self):
        calls = []

        def fetcher(url):
            calls.append(url)
            if "/facility/" in url:
                return {"name": "실내테니스장 시민C코트", "phone": "hidden"}
            if "facility=73" in url and "/rent?" in url:
                return [{"state": "A", "startTime": "2026-11-24 20:00", "endTime": "2026-11-24 22:00"}]
            return []

        config = {
            "booking_groups": [{"courts": [73, 47], "after_days": 1, "days": 2}],
            "watches": [
                {"id": 73, "name": "예전 이름", "enabled": True, "open": "06:00", "close": "22:00", "weekdays": [0, 1], "slots": ["20:00-22:00"]},
                {"id": 47, "name": "테니스장(3번)(인조잔디)", "enabled": True, "open": "08:00", "close": "22:00", "weekdays": [0, 1], "slots": ["20:00-22:00"]},
            ],
        }
        calendars, renamed, failed = crawl_courts(config, date(2026, 11, 23), fetcher)
        self.assertEqual(failed, [])
        observed = observed_slots(config, calendars, date(2026, 11, 23))
        self.assertTrue(renamed)
        self.assertEqual(config["watches"][0]["name"], "실내테니스장 시민C코트")
        self.assertNotIn("73|2026-11-23|20:00-22:00", observed)
        self.assertFalse(observed["73|2026-11-24|20:00-22:00"])
        self.assertTrue(observed["47|2026-11-24|20:00-22:00"])
        self.assertTrue(any(url.startswith("https://www.yssisul.or.kr/rent/api/rent?facility=47") for url in calls))
        self.assertNotIn("phone", str(calendars))

    def test_failed_court_is_retried_once_and_skipped(self):
        calls = []

        def fetcher(url):
            calls.append(url)
            if "facility=66" in url or url.endswith("/facility/66"):
                raise CrawlError("unread")
            if "/facility/" in url:
                return {"name": "테니스장(3번)(인조잔디)"}
            if "facility=47" in url and "/rent?" in url:
                return [{"state": "A", "startTime": "2026-11-24 20:00", "endTime": "2026-11-24 22:00"}]
            return []

        config = {
            "booking_groups": [{"courts": [47, 66], "after_days": 1, "days": 2}],
            "watches": [
                {"id": 47, "name": "테니스장(3번)(인조잔디)", "enabled": True, "open": "08:00", "close": "22:00", "weekdays": [0, 1], "slots": ["20:00-22:00"]},
                {"id": 66, "name": "테니스장(7번)(하드코트)", "enabled": True, "open": "08:00", "close": "22:00", "weekdays": [0, 1], "slots": ["20:00-22:00"]},
            ],
        }
        calendars, _renamed, failed = crawl_courts(config, date(2026, 11, 23), fetcher)
        self.assertEqual(failed, ["66"])
        self.assertIn("47", calendars)
        self.assertNotIn("66", calendars)
        self.assertFalse(observed_slots(config, calendars, date(2026, 11, 23))["47|2026-11-24|20:00-22:00"])
        failed_calls = [url for url in calls if "facility=66" in url or url.endswith("/facility/66")]
        self.assertGreaterEqual(len(failed_calls), 2)
        self.assertEqual(len(failed_calls), len([url for url in calls if "66" in url]) )

    def test_retry_success_keeps_the_court(self):
        seen = {"66": 0}

        def fetcher(url):
            if "66" in url:
                seen["66"] += 1
                if seen["66"] == 1:
                    raise CrawlError("unread")
            if "/facility/" in url:
                return {"name": "테니스장(7번)(하드코트)"}
            return []

        config = {
            "booking_groups": [{"courts": [66], "after_days": 1, "days": 1}],
            "watches": [
                {"id": 66, "name": "예전", "enabled": True, "open": "08:00", "close": "22:00", "weekdays": [0], "slots": ["20:00-22:00"]},
            ],
        }
        calendars, renamed, failed = crawl_courts(config, date(2026, 11, 23), fetcher)
        self.assertEqual(failed, [])
        self.assertIn("66", calendars)
        self.assertTrue(renamed)
        self.assertEqual(config["watches"][0]["name"], "테니스장(7번)(하드코트)")


if __name__ == "__main__":
    unittest.main()
