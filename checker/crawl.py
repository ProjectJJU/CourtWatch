from __future__ import annotations

from datetime import date, timedelta

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

from checker.logic import HORIZON_DAYS, looks_grey, parse_event_titles

EXTRACT_JS = """
() => {
  const norm = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const days = [];
  document.querySelectorAll(".fc-daygrid-day[data-date]").forEach((day) => {
    const frame = day.querySelector(".fc-daygrid-day-frame");
    const titles = [];
    day.querySelectorAll(".fc-event").forEach((event) => {
      const title = event.querySelector(".fc-event-title, .fc-event-title-container");
      const text = norm(title ? title.textContent : event.innerText);
      if (text) titles.push(text);
    });
    days.push({
      date: day.getAttribute("data-date"),
      bg: getComputedStyle(day).backgroundColor,
      frameBg: frame ? getComputedStyle(frame).backgroundColor : "",
      titles,
    });
  });
  return days;
}
"""


class CrawlError(RuntimeError):
    pass


def _day_record(raw: dict) -> dict:
    rest, ranges = parse_event_titles(raw.get("titles") or [])
    grey = looks_grey(raw.get("bg") or "") or looks_grey(raw.get("frameBg") or "")
    return {"grey": grey, "rest": rest, "ranges": ranges}


def _read_visible(page) -> dict[str, dict]:
    raw_days = page.evaluate(EXTRACT_JS)
    found = {}
    for raw in raw_days:
        if raw.get("date"):
            found[raw["date"]] = _day_record(raw)
    return found


def _read_name(page) -> str:
    try:
        name = page.locator(".subTitle").first.inner_text(timeout=3000)
    except PlaywrightTimeout:
        return ""
    return " ".join(name.split())


def _read_court(page, url: str, start: date, end: date) -> tuple[dict[str, dict], str]:
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector(".fc-daygrid-day", timeout=30000)
        page.wait_for_timeout(2000)
    except PlaywrightTimeout as exc:
        raise CrawlError("calendar did not load") from exc
    name = _read_name(page)
    merged: dict[str, dict] = {}
    target = end.isoformat()
    for _ in range(4):
        try:
            visible = _read_visible(page)
        except PlaywrightTimeout as exc:
            raise CrawlError("calendar could not be read") from exc
        if not visible:
            raise CrawlError("calendar was empty")
        merged.update(visible)
        if target <= max(visible):
            break
        button = page.locator(".fc-customNext-button, .fc-next-button")
        if button.count() == 0 or not button.first.is_enabled():
            break
        button.first.click()
        page.wait_for_timeout(2000)
    if not merged:
        raise CrawlError("calendar was empty")
    return merged, name


def crawl_courts(config: dict, today: date) -> tuple[dict[str, dict], bool]:
    watches = [watch for watch in config.get("watches", []) if watch.get("enabled", True)]
    if not watches:
        return {}
    end = today + timedelta(days=HORIZON_DAYS - 1)
    calendars: dict[str, dict] = {}
    renamed = False
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context(
                locale="ko-KR",
                timezone_id="Asia/Seoul",
                viewport={"width": 1280, "height": 900},
            )
            for watch in watches:
                page = context.new_page()
                page.route(
                    "**/*.{png,jpg,jpeg,gif,webp,woff,woff2}",
                    lambda route: route.abort(),
                )
                try:
                    days, name = _read_court(page, watch["url"], today, end)
                    calendars[str(watch["id"])] = days
                    if name and watch.get("name") != name:
                        watch["name"] = name
                        renamed = True
                except CrawlError:
                    raise
                except Exception as exc:
                    raise CrawlError(f"court {watch['id']} could not be read") from exc
                finally:
                    page.close()
        finally:
            browser.close()
    return calendars, renamed
