import unittest
from datetime import date

from checker.crawl import calendar_days, crawl_courts, months_covering, occupied_by_day
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
        calendars, renamed = crawl_courts(config, date(2026, 11, 23), fetcher)
        observed = observed_slots(config, calendars, date(2026, 11, 23))
        self.assertTrue(renamed)
        self.assertEqual(config["watches"][0]["name"], "실내테니스장 시민C코트")
        self.assertNotIn("73|2026-11-23|20:00-22:00", observed)
        self.assertFalse(observed["73|2026-11-24|20:00-22:00"])
        self.assertTrue(observed["47|2026-11-24|20:00-22:00"])
        self.assertTrue(any(url.startswith("https://www.yssisul.or.kr/rent/api/rent?facility=47") for url in calls))
        self.assertNotIn("phone", str(calendars))


if __name__ == "__main__":
    unittest.main()
