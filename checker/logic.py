from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

WEEKDAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"]
HORIZON_DAYS = 35
OCCUPIED_STATES = {"신청", "승인", "결제"}
IGNORED_STATES = {"취소", "환불"}
RANGE_RE = re.compile(r"(\d{2}:\d{2})\s*[~\-]\s*(\d{2}:\d{2})")
STATUS_RE = re.compile(r"\[(신청|승인|결제|취소|환불|휴관)\]")
HM_RE = re.compile(r"^(\d{2}):(\d{2})$")


ALERT_HISTORY_LIMIT = 10


def fresh_state() -> dict:
    return {
        "initialized": False,
        "update_offset": None,
        "awaiting": None,
        "slots": {},
        "pending": [],
        "failure_pending": False,
        "failure_notified": False,
        "last_check": None,
        "last_error": None,
        "last_alerts": [],
        "alert_history": [],
        "open_now": [],
    }


def record_alert_history(state: dict, at: str) -> None:
    keys = [str(key) for key in (state.get("last_alerts") or []) if key]
    if not keys:
        return
    history = [
        item
        for item in (state.get("alert_history") or [])
        if isinstance(item, dict) and item.get("keys")
    ]
    history.insert(0, {"at": str(at or ""), "keys": keys})
    state["alert_history"] = history[:ALERT_HISTORY_LIMIT]


def needs_state_save(previous: dict, current: dict) -> bool:
    if previous.get("last_check") != current.get("last_check"):
        return True
    before = dict(previous)
    after = dict(current)
    before.pop("last_check", None)
    after.pop("last_check", None)
    return before != after


def seoul_now(now: datetime | None = None) -> datetime:
    if now is None:
        return datetime.now(ZoneInfo("Asia/Seoul"))
    if now.tzinfo is None:
        return now.replace(tzinfo=ZoneInfo("Asia/Seoul"))
    return now.astimezone(ZoneInfo("Asia/Seoul"))


def parse_hm(value: str) -> time | None:
    match = HM_RE.fullmatch(str(value).strip())
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    return time(hour, minute)


def in_sleep(now: datetime, start: str, end: str) -> bool:
    start_t = parse_hm(start)
    end_t = parse_hm(end)
    if start_t is None or end_t is None or start_t == end_t:
        return False
    current = now.time().replace(second=0, microsecond=0)
    if start_t < end_t:
        return start_t <= current < end_t
    return current >= start_t or current < end_t


def slot_bounds(slot: str) -> tuple[str, str] | None:
    parts = str(slot).split("-")
    if len(parts) != 2:
        return None
    if parse_hm(parts[0]) is None or parse_hm(parts[1]) is None:
        return None
    if parts[0] >= parts[1]:
        return None
    return parts[0], parts[1]


def within_hours(slot: str, open_hm: str, close_hm: str) -> bool:
    bounds = slot_bounds(slot)
    if bounds is None or parse_hm(open_hm) is None or parse_hm(close_hm) is None:
        return False
    start, end = bounds
    return start >= open_hm and end <= close_hm


def overlaps(slot: str, busy_start: str, busy_end: str) -> bool:
    bounds = slot_bounds(slot)
    if bounds is None:
        return False
    start, end = bounds
    return start < busy_end and busy_start < end


def menu_slots(open_hm: str, close_hm: str) -> list[str]:
    start = parse_hm(open_hm) or time(6, 0)
    end = parse_hm(close_hm) or time(22, 0)
    floor = time(6, 0)
    ceiling = time(22, 0)
    if start < floor:
        start = floor
    if end > ceiling:
        end = ceiling
    cursor = datetime(2000, 1, 1, start.hour, start.minute)
    stop = datetime(2000, 1, 1, end.hour, end.minute)
    slots = []
    while cursor + timedelta(hours=2) <= stop:
        nxt = cursor + timedelta(hours=2)
        slots.append(f"{cursor.strftime('%H:%M')}-{nxt.strftime('%H:%M')}")
        cursor = nxt
    return slots


def looks_grey(color: str) -> bool:
    if not color:
        return False
    nums = [int(item) for item in re.findall(r"\d+", color)]
    if len(nums) >= 4 and nums[3] == 0:
        return False
    if len(nums) < 3:
        return False
    red, green, blue = nums[:3]
    return abs(red - 230) <= 12 and abs(green - 230) <= 12 and abs(blue - 230) <= 12


def parse_event_titles(titles: list[str]) -> tuple[bool, list[tuple[str, str]]]:
    rest = False
    ranges: list[tuple[str, str]] = []
    for raw in titles:
        text = raw.replace("\xa0", " ")
        if "휴관" in text:
            rest = True
        for match in STATUS_RE.finditer(text):
            status = match.group(1)
            if status == "휴관":
                rest = True
                continue
            window = text[match.end() : match.end() + 40]
            found = RANGE_RE.search(window)
            if found is None or status in IGNORED_STATES:
                continue
            if status in OCCUPIED_STATES:
                ranges.append((found.group(1), found.group(2)))
    return rest, ranges


def slot_key(court_id: int | str, day: str, slot: str) -> str:
    return f"{court_id}|{day}|{slot}"


def split_key(key: str) -> tuple[str, str, str]:
    court_id, day, slot = key.split("|", 2)
    return court_id, day, slot


def watch_by_id(config: dict) -> dict[str, dict]:
    return {str(watch["id"]): watch for watch in config.get("watches", [])}


def _as_int(value: object, default: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _release_trim_end(end: date, release: object, now: datetime | None) -> date:
    release_hm = str(release or "").strip()
    release_t = parse_hm(release_hm) if release_hm else None
    if release_t is None or now is None:
        return end
    current = now.time().replace(second=0, microsecond=0)
    if current < release_t:
        return end - timedelta(days=1)
    return end


def booking_window(
    config: dict, court_id: object, today: date, now: datetime | None = None
) -> tuple[date, date] | None:
    groups = config.get("booking_groups") or []
    if not groups:
        return today, today + timedelta(days=HORIZON_DAYS - 1)
    for group in groups:
        courts = {str(item) for item in group.get("courts") or []}
        if str(court_id) not in courts:
            continue
        after = _as_int(group.get("after_days"))
        days = _as_int(group.get("days"))
        if after < 0 or days < 1:
            return None
        start = today + timedelta(days=after)
        end = start + timedelta(days=days - 1)
        return start, _release_trim_end(end, group.get("release"), now)
    return None


def crawl_end(config: dict, today: date, now: datetime | None = None) -> date:
    groups = config.get("booking_groups") or []
    if not groups:
        return today + timedelta(days=HORIZON_DAYS - 1)
    end = today
    for group in groups:
        after = _as_int(group.get("after_days"))
        days = _as_int(group.get("days"))
        if after < 0 or days < 1:
            continue
        group_end = _release_trim_end(
            today + timedelta(days=after + days - 1), group.get("release"), now
        )
        if group_end > end:
            end = group_end
    return end


def base_slots_for_day(watch: dict, weekday: int) -> list[str]:
    has_split = "weekday_slots" in watch or "weekend_slots" in watch
    if has_split:
        if weekday < 5:
            return [str(slot) for slot in watch.get("weekday_slots") or []]
        return [str(slot) for slot in watch.get("weekend_slots") or []]
    weekdays = {int(day) for day in watch.get("weekdays") or []}
    if weekday not in weekdays:
        return []
    return [str(slot) for slot in watch.get("slots") or []]


def _extra_matches(extra: dict, weekday: int, day_iso: str) -> bool:
    dates = {str(item) for item in extra.get("dates") or []}
    days = {int(item) for item in extra.get("weekdays") or []}
    if day_iso in dates:
        return True
    if days and weekday in days:
        return True
    return False


def slots_for_day(watch: dict, weekday: int, day_iso: str | None = None) -> list[str]:
    base = base_slots_for_day(watch, weekday)
    extras = [item for item in watch.get("extras") or [] if isinstance(item, dict)]
    if not extras:
        return base
    iso = day_iso or ""
    matched = [item for item in extras if _extra_matches(item, weekday, iso)]
    if not matched:
        return base
    add_slots: list[str] = []
    replace_slots: list[str] = []
    replaced = False
    for extra in matched:
        slots = [str(slot) for slot in extra.get("slots") or []]
        if extra.get("replace"):
            replaced = True
            replace_slots.extend(slots)
        else:
            add_slots.extend(slots)
    if replaced:
        return sorted(set(replace_slots + add_slots))
    return sorted(set(base + add_slots))


def observed_slots(
    config: dict, calendars: dict, today: date, now: datetime | None = None
) -> dict[str, bool]:
    observed: dict[str, bool] = {}
    for watch in config.get("watches", []):
        if not watch.get("enabled", True):
            continue
        court_id = str(watch["id"])
        window = booking_window(config, court_id, today, now)
        if window is None:
            continue
        start, end = window
        days = calendars.get(court_id, {})
        current = start
        while current <= end:
            weekday = current.weekday()
            iso = current.isoformat()
            slots = slots_for_day(watch, weekday, iso)
            info = days.get(iso)
            current += timedelta(days=1)
            if not slots or not info:
                continue
            for slot in slots:
                if not within_hours(slot, watch.get("open", "06:00"), watch.get("close", "22:00")):
                    continue
                key = slot_key(court_id, iso, slot)
                if info.get("grey") or info.get("rest"):
                    observed[key] = False
                    continue
                busy = False
                for busy_start, busy_end in info.get("ranges", []):
                    if overlaps(slot, busy_start, busy_end):
                        busy = True
                        break
                observed[key] = not busy
    return observed


def is_status_command(title: str, message: str) -> bool:
    body = " ".join(str(message or "").split())
    heading = " ".join(str(title or "").split())
    if body in {"확인", "체크"}:
        return True
    return body == "" and heading in {"확인", "체크"}


def _prune(slots: dict, pending: set[str], today_iso: str) -> None:
    for key in list(slots):
        day = split_key(key)[1]
        if day < today_iso:
            slots.pop(key, None)
            pending.discard(key)
    for key in list(pending):
        if split_key(key)[1] < today_iso:
            pending.discard(key)


def collect_alerts(state: dict, observed: dict[str, bool], muted: bool, today_iso: str) -> list[str]:
    slots = dict(state.get("slots") or {})
    pending = set(state.get("pending") or [])
    send: list[str] = []
    discovered: list[str] = []

    if not state.get("initialized"):
        for key, is_open in observed.items():
            slots[key] = is_open
        _prune(slots, pending, today_iso)
        state["slots"] = slots
        state["pending"] = sorted(pending)
        state["initialized"] = True
        state["last_alerts"] = []
        state.setdefault("alert_history", [])
        state["open_now"] = sorted(key for key, is_open in observed.items() if is_open)
        return []

    for key, is_open in observed.items():
        if key not in slots:
            if not is_open:
                slots[key] = False
                continue
            slots[key] = False
        previous = bool(slots.get(key, False))
        if is_open and not previous:
            if key not in discovered:
                discovered.append(key)
            if muted:
                pending.add(key)
                slots[key] = True
            elif key not in send:
                send.append(key)
        elif not is_open:
            pending.discard(key)
            slots[key] = False
        else:
            slots[key] = True

    if not muted:
        for key in sorted(pending):
            if observed.get(key) is True and key not in send:
                send.append(key)
            elif key in observed and not observed[key]:
                pending.discard(key)

    _prune(slots, pending, today_iso)
    state["slots"] = slots
    state["pending"] = sorted(pending)
    state["last_alerts"] = list(discovered)
    state["open_now"] = sorted(key for key, is_open in observed.items() if is_open)
    return send


def acknowledge(state: dict, keys: list[str]) -> None:
    slots = dict(state.get("slots") or {})
    pending = set(state.get("pending") or [])
    for key in keys:
        slots[key] = True
        pending.discard(key)
    state["slots"] = slots
    state["pending"] = sorted(pending)


def failure_should_send(state: dict, muted: bool) -> bool:
    if muted:
        state["failure_pending"] = True
        return False
    if state.get("failure_notified"):
        return False
    return True


def acknowledge_failure(state: dict) -> None:
    state["failure_notified"] = True
    state["failure_pending"] = False


def note_recovery(state: dict) -> None:
    state["failure_pending"] = False
    state["failure_notified"] = False
    state["last_error"] = None


def format_weekday(day: date) -> str:
    return WEEKDAY_LABELS[day.weekday()]


def format_weekdays(days: list[int]) -> str:
    ordered = sorted(set(int(day) for day in days))
    if ordered == list(range(7)):
        return "매일"
    if ordered == [0, 1, 2, 3, 4]:
        return "평일"
    if ordered == [5, 6]:
        return "주말"
    return "".join(WEEKDAY_LABELS[day] for day in ordered if 0 <= day <= 6)


_LINK_RE = re.compile(
    r"(?i)(?:\[[^\]]+\]\([^)]+\)|<\s*https?://[^>]+>|https?://\S+|www\.\S+|javascript:\S+|data:\S+)"
)


def visible_text(value: object) -> str:
    return " ".join(_LINK_RE.sub("", str(value or "")).split())


def render_alert(config: dict, keys: list[str]) -> str:
    grouped: dict[str, list[tuple[str, str]]] = {}
    for key in dict.fromkeys(keys):
        court_id, day, slot = split_key(key)
        grouped.setdefault(court_id, []).append((day, slot))
    lines = ["빈 코트", ""]
    watches = watch_by_id(config)
    ordered = [str(watch["id"]) for watch in config.get("watches", []) if str(watch["id"]) in grouped]
    ordered.extend(court_id for court_id in grouped if court_id not in ordered)
    for court_id in ordered:
        items = grouped[court_id]
        watch = watches.get(court_id, {})
        lines.append(visible_text(watch.get("name")) or court_id)
        for day, slot in sorted(items):
            current = date.fromisoformat(day)
            lines.append(f"{day} ({format_weekday(current)}) {slot}")
        lines.append("")
    lines.append("먼저 예약될 수 있습니다")
    return "\n".join(lines).strip()


def render_open_now(config: dict, keys: list[str]) -> str:
    if not keys:
        return "지금 빈 시간이 없습니다."
    lines = render_alert(config, keys).splitlines()
    if lines:
        lines[0] = "지금 빈 시간"
    return "\n".join(lines)


def render_status(config: dict, state: dict) -> str:
    sleep = config.get("sleep") or {}
    start = str(sleep.get("start") or "")
    end = str(sleep.get("end") or "")
    if parse_hm(start) and parse_hm(end) and start != end:
        sleep_line = f"수면: {start}-{end}"
    else:
        sleep_line = "수면: 없음"
    lines = [
        sleep_line,
        "알림: 켜짐" if config.get("alerts_enabled", True) else "알림: 꺼짐",
        *_booking_lines(config),
        f"마지막 검사: {state.get('last_check') or '없음'}",
    ]
    if state.get("last_error"):
        lines.append(f"마지막 오류: {state['last_error']}")
    lines.append("")
    lines.append("코트")
    for watch in config.get("watches", []):
        flag = "켜짐" if watch.get("enabled", True) else "꺼짐"
        slots = ", ".join(watch.get("slots") or []) or "없음"
        lines.append(
            f"{visible_text(watch.get('name')) or watch.get('id')} [{flag}] "
            f"{format_weekdays(watch.get('weekdays') or [])} {slots}"
        )
    lines.append("")
    open_now = state.get("open_now") or []
    if not open_now:
        lines.append("지금 빈 슬롯 없음")
    else:
        lines.append("지금 빈 슬롯")
        watches = watch_by_id(config)
        for key in open_now:
            court_id, day, slot = split_key(key)
            name = visible_text(watches.get(court_id, {}).get("name")) or court_id
            current = date.fromisoformat(day)
            lines.append(f"{name} {day} ({format_weekday(current)}) {slot}")
    return "\n".join(lines)


def forget_courts(state: dict, court_ids: set[str]) -> None:
    if not court_ids:
        return

    def keep(key: str) -> bool:
        return split_key(key)[0] not in court_ids

    state["slots"] = {key: value for key, value in (state.get("slots") or {}).items() if keep(key)}
    state["pending"] = [key for key in state.get("pending") or [] if keep(key)]
    state["open_now"] = [key for key in state.get("open_now") or [] if keep(key)]


def _booking_lines(config: dict) -> list[str]:
    groups = config.get("booking_groups") or []
    if not groups:
        return [f"기간: 오늘부터 {HORIZON_DAYS}일"]
    lines = []
    for group in groups:
        name = visible_text(group.get("name")) or str(group.get("id") or "예약")
        after = _as_int(group.get("after_days"))
        days = _as_int(group.get("days"))
        lines.append(f"{name}: {after}일 뒤부터 {days}일")
    return lines


def is_muted(config: dict, now: datetime) -> bool:
    if not config.get("alerts_enabled", True):
        return True
    sleep = config.get("sleep") or {}
    return in_sleep(now, str(sleep.get("start") or ""), str(sleep.get("end") or ""))
