from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

import requests

from checker.logic import booking_window

API = "https://www.yssisul.or.kr/rent/api"
OCCUPIED = {"N", "A", "P"}


class CrawlError(RuntimeError):
    pass


def months_covering(start: date, end: date) -> list[str]:
    months: list[str] = []
    year, month = start.year, start.month
    last = f"{end.year:04d}-{end.month:02d}"
    while f"{year:04d}-{month:02d}" <= last and len(months) < 6:
        months.append(f"{year:04d}-{month:02d}")
        if month == 12:
            year += 1
            month = 1
        else:
            month += 1
    return months


def _day_of(value: object) -> str:
    text = str(value or "")
    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        day = text[:10]
        if day[0:4].isdigit() and day[5:7].isdigit() and day[8:10].isdigit():
            return day
    return ""


def _hm_of(value: object) -> str:
    text = str(value or "")
    mark = text.find(" ")
    clock = text[mark + 1 : mark + 6] if mark >= 0 else text[:5]
    if len(clock) == 5 and clock[2] == ":" and clock[:2].isdigit() and clock[3:].isdigit():
        return clock
    return ""


def occupied_by_day(reservations: list) -> dict[str, list[tuple[str, str]]]:
    by_day: dict[str, list[tuple[str, str]]] = {}

    def push(day: str, start: str, end: str) -> None:
        if day and start and end and start < end:
            by_day.setdefault(day, []).append((start, end))

    for item in reservations:
        if not isinstance(item, dict) or str(item.get("state") or "") not in OCCUPIED:
            continue
        start_day = _day_of(item.get("startTime"))
        end_day = _day_of(item.get("endTime")) or start_day
        start = _hm_of(item.get("startTime"))
        end = _hm_of(item.get("endTime"))
        if not start_day or not start or not end:
            continue
        if start_day == end_day:
            push(start_day, start, end)
            continue
        push(start_day, start, "24:00")
        if end != "00:00":
            push(end_day, "00:00", end)
    return by_day


def rest_dates(rows: list) -> set[str]:
    dates: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        start = _day_of(row.get("startDay"))
        end = _day_of(row.get("endDay")) or start
        if not start or end < start:
            continue
        cursor = date.fromisoformat(start)
        last = date.fromisoformat(end)
        while cursor <= last and len(dates) < 400:
            dates.add(cursor.isoformat())
            cursor += timedelta(days=1)
    return dates


def calendar_days(start: date, end: date, reservations: list, rests: list) -> dict[str, dict]:
    ranges = occupied_by_day(reservations)
    closed = rest_dates(rests)
    days: dict[str, dict] = {}
    current = start
    while current <= end:
        iso = current.isoformat()
        days[iso] = {"grey": False, "rest": iso in closed, "ranges": ranges.get(iso, [])}
        current += timedelta(days=1)
    return days


def _as_list(payload: object) -> list:
    if isinstance(payload, list):
        return payload
    raise CrawlError("reservation list was not readable")


def _fetch_json(url: str) -> object:
    try:
        response = requests.get(
            url,
            headers={"Accept": "application/json", "User-Agent": "court-watch"},
            timeout=20,
        )
        response.raise_for_status()
        return response.json()
    except CrawlError:
        raise
    except Exception as exc:
        raise CrawlError("reservation list was not readable") from exc


def _read_court(watch: dict, today: date, fetcher, now=None) -> tuple[str, dict, str]:
    court_id = str(watch["id"])
    window = booking_window(
        {"booking_groups": watch.get("_groups") or []}, court_id, today, now
    )
    if window is None:
        return court_id, {}, ""
    start, end = window
    reservations: list = []
    rests: list = []
    for month in months_covering(start, end):
        rent = fetcher(f"{API}/rent?facility={court_id}&month={month}")
        rest = fetcher(f"{API}/restday?facility={court_id}&month={month}")
        reservations.extend(_as_list(rent))
        rests.extend(_as_list(rest))
    name = ""
    try:
        facility = fetcher(f"{API}/facility/{court_id}")
    except Exception:
        facility = None
    if isinstance(facility, dict):
        name = " ".join(str(facility.get("name") or "").split())
    return court_id, calendar_days(start, end, reservations, rests), name


def _load_court(watch: dict, today: date, fetcher, now=None) -> tuple[str, dict, str, str]:
    court_id = str(watch["id"])
    for _attempt in range(2):
        try:
            loaded_id, days, name = _read_court(watch, today, fetcher, now)
            return loaded_id, days, name, ""
        except Exception:
            continue
    return court_id, {}, "", court_id


def crawl_courts(config: dict, today: date, fetcher=None, now=None) -> tuple[dict[str, dict], bool, list[str]]:
    watches = [watch for watch in config.get("watches", []) if watch.get("enabled", True)]
    if not watches:
        return {}, False, []
    load = fetcher or _fetch_json
    groups = config.get("booking_groups") or []
    jobs = [{**watch, "_groups": groups} for watch in watches]
    loaded: dict[str, tuple[dict, str, str]] = {}
    workers = min(len(jobs), 8)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_load_court, watch, today, load, now): str(watch["id"]) for watch in jobs
        }
        for future in as_completed(futures):
            court_id, days, name, error = future.result()
            loaded[court_id] = (days, name, error)
    calendars: dict[str, dict] = {}
    failed: list[str] = []
    renamed = False
    for watch in watches:
        court_id = str(watch["id"])
        days, name, error = loaded.get(court_id, ({}, "", court_id))
        if error:
            failed.append(court_id)
            continue
        if not days:
            continue
        calendars[court_id] = days
        if name and watch.get("name") != name:
            watch["name"] = name
            renamed = True
    return calendars, renamed, failed
