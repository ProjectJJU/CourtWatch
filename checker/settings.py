from __future__ import annotations

import re

from checker.logic import (
    forget_courts,
    format_weekdays,
    menu_slots,
    parse_hm,
    render_status,
    watch_by_id,
)

COURT_URL = "https://www.yssisul.or.kr/rent/#/{court_id}/rent/step1"
COURT_ID_RE = re.compile(r"(?:#/|/)(\d+)/rent(?:/step1)?(?:\b|$)")

SLEEP_TEXT_RE = re.compile(r"^\s*(\d{1,2}:\d{2})\s*[-~]?\s*(\d{1,2}:\d{2})\s*$")


def _normalize_hm(value: str) -> str | None:
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", value.strip())
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    normalized = f"{hour:02d}:{minute:02d}"
    if parse_hm(normalized) is None:
        return None
    return normalized


def _watch(config: dict, court_id: str) -> dict | None:
    return watch_by_id(config).get(str(court_id))


def _preset(config: dict, preset_id: str) -> dict | None:
    for preset in config.get("presets", []):
        if str(preset.get("id")) == str(preset_id):
            return preset
    return None


def main_keyboard(config: dict) -> dict:
    alerts_on = bool(config.get("alerts_enabled", True))
    return {
        "inline_keyboard": [
            [{"text": "현황", "callback_data": "m:st"}],
            [
                {"text": "수면", "callback_data": "m:sl"},
                {"text": "코트", "callback_data": "m:ct"},
            ],
            [
                {"text": "시간", "callback_data": "m:tm"},
                {"text": "요일", "callback_data": "m:wd"},
            ],
            [
                {"text": "기간", "callback_data": "m:dy"},
                {"text": "프리셋", "callback_data": "m:pr"},
            ],
            [{"text": "주소", "callback_data": "m:ur"}],
            [
                {
                    "text": "알림 끄기" if alerts_on else "알림 켜기",
                    "callback_data": "al:0" if alerts_on else "al:1",
                },
                {"text": "연결 테스트", "callback_data": "m:ts"},
            ],
        ]
    }


def _back_row() -> list[dict]:
    return [{"text": "메뉴", "callback_data": "m:menu"}]


def _court_rows(config: dict, prefix: str) -> list[list[dict]]:
    rows = []
    for watch in config.get("watches", []):
        mark = "켜짐" if watch.get("enabled", True) else "꺼짐"
        rows.append(
            [
                {
                    "text": f"{watch.get('name')} ({mark})",
                    "callback_data": f"{prefix}:{watch['id']}",
                }
            ]
        )
    rows.append(_back_row())
    return rows


def sleep_keyboard() -> dict:
    return {
        "inline_keyboard": [
            [{"text": "수면 없음", "callback_data": "ss:none"}],
            [
                {"text": "23:00-07:00", "callback_data": "ss:2307"},
                {"text": "00:00-08:00", "callback_data": "ss:0008"},
            ],
            [{"text": "직접 입력", "callback_data": "ss:ask"}],
            _back_row(),
        ]
    }


def court_keyboard(config: dict) -> dict:
    rows = []
    for watch in config.get("watches", []):
        enabled = bool(watch.get("enabled", True))
        label = f"{'끄기' if enabled else '켜기'} {watch.get('name')}"
        rows.append(
            [
                {
                    "text": label,
                    "callback_data": f"ce:{watch['id']}:{0 if enabled else 1}",
                }
            ]
        )
    rows.append(_back_row())
    return {"inline_keyboard": rows}


def slot_keyboard(config: dict, court_id: str) -> dict:
    watch = _watch(config, court_id) or {}
    selected = set(watch.get("slots") or [])
    rows = []
    row: list[dict] = []
    for slot in menu_slots(str(watch.get("open") or "06:00"), str(watch.get("close") or "22:00")):
        mark = "✓ " if slot in selected else ""
        hour = slot[:2]
        row.append(
            {
                "text": f"{mark}{slot}",
                "callback_data": f"ts:{court_id}:{hour}:{0 if slot in selected else 1}",
            }
        )
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    rows.append(_back_row())
    return {"inline_keyboard": rows}


def weekday_keyboard(config: dict, court_id: str) -> dict:
    watch = _watch(config, court_id) or {}
    selected = set(int(day) for day in watch.get("weekdays") or [])
    rows = [
        [
            {"text": "매일", "callback_data": f"wa:{court_id}:all"},
            {"text": "평일", "callback_data": f"wa:{court_id}:wd"},
            {"text": "주말", "callback_data": f"wa:{court_id}:we"},
        ]
    ]
    row = []
    for index, label in enumerate(["월", "화", "수", "목", "금", "토", "일"]):
        mark = "✓" if index in selected else ""
        row.append(
            {
                "text": f"{mark}{label}",
                "callback_data": f"wt:{court_id}:{index}:{0 if index in selected else 1}",
            }
        )
        if len(row) == 4:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    rows.append(_back_row())
    return {"inline_keyboard": rows}


def days_keyboard() -> dict:
    return {
        "inline_keyboard": [
            [
                {"text": "7일", "callback_data": "dy:7"},
                {"text": "14일", "callback_data": "dy:14"},
            ],
            _back_row(),
        ]
    }


def address_keyboard(config: dict) -> dict:
    rows = []
    for watch in config.get("watches", []):
        rows.append(
            [
                {"text": f"변경 {watch.get('name')}", "callback_data": f"uu:{watch['id']}"},
                {"text": "삭제", "callback_data": f"ud:{watch['id']}"},
            ]
        )
    rows.append([{"text": "코트 추가", "callback_data": "ua"}])
    rows.append(_back_row())
    return {"inline_keyboard": rows}


def parse_court_address(text: str) -> tuple[int, str] | None:
    raw = text.strip()
    if re.fullmatch(r"\d{1,6}", raw):
        court_id = int(raw)
        return court_id, COURT_URL.format(court_id=court_id)
    match = COURT_ID_RE.search(raw)
    if match is None:
        return None
    court_id = int(match.group(1))
    return court_id, COURT_URL.format(court_id=court_id)


def _default_watch(court_id: int, url: str) -> dict:
    return {
        "id": court_id,
        "name": f"코트 {court_id}",
        "url": url,
        "enabled": True,
        "open": "06:00",
        "close": "22:00",
        "weekdays": [0, 1, 2, 3, 4],
        "slots": ["18:00-20:00", "20:00-22:00"],
    }


def preset_keyboard(config: dict, court_id: str) -> dict:
    rows = []
    for preset in config.get("presets", []):
        rows.append(
            [
                {
                    "text": str(preset.get("label") or preset.get("id")),
                    "callback_data": f"ps:{court_id}:{preset.get('id')}",
                }
            ]
        )
    rows.append(_back_row())
    return {"inline_keyboard": rows}


def _set_sleep(config: dict, start: str, end: str) -> None:
    config["sleep"] = {"start": start, "end": end}


def _set_weekdays(watch: dict, days: list[int]) -> None:
    watch["weekdays"] = sorted(set(days))


def apply_callback(config: dict, state: dict, data: str) -> tuple[str, dict | None, bool, bool]:
    """Return text, keyboard, config_changed, send_test."""
    parts = data.split(":")
    kind = parts[0]

    if data == "m:menu":
        state["awaiting"] = None
        return "설정을 고르세요.", main_keyboard(config), False, False
    if data == "m:st":
        return render_status(config, state), main_keyboard(config), False, False
    if data == "m:sl":
        return "수면 시간을 고르거나 23:30 07:00처럼 보내세요.", sleep_keyboard(), False, False
    if data == "m:ct":
        return "코트를 켜거나 끕니다.", court_keyboard(config), False, False
    if data == "m:tm":
        return "시간을 바꿀 코트를 고르세요.", {"inline_keyboard": _court_rows(config, "tc")}, False, False
    if data == "m:wd":
        return "요일을 바꿀 코트를 고르세요.", {"inline_keyboard": _court_rows(config, "wc")}, False, False
    if data == "m:dy":
        return "앞으로 볼 날짜 수입니다.", days_keyboard(), False, False
    if data == "m:pr":
        return "프리셋을 적용할 코트를 고르세요.", {"inline_keyboard": _court_rows(config, "pc")}, False, False
    if data == "m:ur":
        state["awaiting"] = None
        return "주소를 바꿀 코트를 고르거나 코트를 추가하세요.", address_keyboard(config), False, False
    if data == "m:ts":
        return "연결 확인을 보냅니다.", main_keyboard(config), False, True
    if data == "ua":
        state["awaiting"] = "url:add"
        return (
            "추가할 주소나 코트 번호를 보내세요. 예: 73 또는 "
            "https://www.yssisul.or.kr/rent/#/73/rent/step1",
            address_keyboard(config),
            False,
            False,
        )

    if kind == "ss" and len(parts) == 2:
        choice = parts[1]
        if choice == "ask":
            state["awaiting"] = "sleep"
            return "시작과 끝을 23:30 07:00 형식으로 보내세요.", sleep_keyboard(), False, False
        if choice == "none":
            state["awaiting"] = None
            _set_sleep(config, "00:00", "00:00")
            return "수면 시간을 없앴습니다.", main_keyboard(config), True, False
        mapped = {"2307": ("23:00", "07:00"), "0008": ("00:00", "08:00")}
        if choice in mapped:
            state["awaiting"] = None
            _set_sleep(config, *mapped[choice])
            start, end = mapped[choice]
            return f"수면 시간을 {start}-{end}으로 저장했습니다.", main_keyboard(config), True, False

    if kind == "ce" and len(parts) == 3:
        watch = _watch(config, parts[1])
        if watch is not None:
            watch["enabled"] = parts[2] == "1"
            flag = "켰습니다" if watch["enabled"] else "껐습니다"
            return f"{watch.get('name')} 감시를 {flag}.", court_keyboard(config), True, False

    if kind == "tc" and len(parts) == 2:
        watch = _watch(config, parts[1])
        if watch is not None:
            return f"{watch.get('name')} 시간", slot_keyboard(config, parts[1]), False, False

    if kind == "ts" and len(parts) == 4:
        watch = _watch(config, parts[1])
        if watch is not None:
            hour = int(parts[2])
            slot = f"{hour:02d}:00-{hour + 2:02d}:00"
            slots = list(watch.get("slots") or [])
            if parts[3] == "1" and slot not in slots:
                slots.append(slot)
            if parts[3] == "0" and slot in slots:
                slots.remove(slot)
            watch["slots"] = sorted(slots)
            return f"{watch.get('name')} 시간", slot_keyboard(config, parts[1]), True, False

    if kind == "wc" and len(parts) == 2:
        watch = _watch(config, parts[1])
        if watch is not None:
            return f"{watch.get('name')} 요일 {format_weekdays(watch.get('weekdays') or [])}", weekday_keyboard(config, parts[1]), False, False

    if kind == "wa" and len(parts) == 3:
        watch = _watch(config, parts[1])
        if watch is not None:
            chosen = {"all": list(range(7)), "wd": [0, 1, 2, 3, 4], "we": [5, 6]}.get(parts[2])
            if chosen is not None:
                _set_weekdays(watch, chosen)
                return f"{watch.get('name')} 요일을 {format_weekdays(chosen)}로 저장했습니다.", weekday_keyboard(config, parts[1]), True, False

    if kind == "wt" and len(parts) == 4:
        watch = _watch(config, parts[1])
        if watch is not None:
            day = int(parts[2])
            days = set(int(item) for item in watch.get("weekdays") or [])
            if parts[3] == "1":
                days.add(day)
            else:
                days.discard(day)
            _set_weekdays(watch, sorted(days))
            return f"{watch.get('name')} 요일", weekday_keyboard(config, parts[1]), True, False

    if kind == "dy" and len(parts) == 2 and parts[1] in {"7", "14"}:
        config["lookahead_days"] = int(parts[1])
        return f"기간을 {parts[1]}일로 저장했습니다.", days_keyboard(), True, False

    if kind == "pc" and len(parts) == 2:
        watch = _watch(config, parts[1])
        if watch is not None:
            return f"{watch.get('name')} 프리셋", preset_keyboard(config, parts[1]), False, False

    if kind == "ps" and len(parts) == 3:
        watch = _watch(config, parts[1])
        preset = _preset(config, parts[2])
        if watch is not None and preset is not None:
            _set_weekdays(watch, [int(day) for day in preset.get("weekdays") or []])
            watch["slots"] = list(preset.get("slots") or [])
            watch["enabled"] = True
            return (
                f"{watch.get('name')}에 {preset.get('label')}을 적용했습니다.",
                preset_keyboard(config, parts[1]),
                True,
                False,
            )

    if kind == "uu" and len(parts) == 2 and _watch(config, parts[1]) is not None:
        state["awaiting"] = f"url:{parts[1]}"
        watch = _watch(config, parts[1])
        return (
            f"{watch.get('name')} 코트 번호만 보내세요.",
            address_keyboard(config),
            False,
            False,
        )

    if kind == "ud" and len(parts) == 2:
        watch = _watch(config, parts[1])
        if watch is not None:
            config["watches"] = [
                item for item in config.get("watches", []) if str(item.get("id")) != str(parts[1])
            ]
            forget_courts(state, {str(parts[1])})
            state["awaiting"] = None
            return f"{watch.get('name')} 감시를 뺐습니다.", address_keyboard(config), True, False

    if kind == "al" and len(parts) == 2:
        config["alerts_enabled"] = parts[1] == "1"
        text = "알림을 켰습니다." if config["alerts_enabled"] else "알림을 껐습니다. 검사는 계속합니다."
        return text, main_keyboard(config), True, False

    return "알 수 없는 설정입니다.", main_keyboard(config), False, False


def apply_text(config: dict, state: dict, text: str) -> tuple[str, dict | None, bool, bool] | None:
    stripped = text.strip()
    if stripped in {"/menu", "/start"}:
        state["awaiting"] = None
        return "설정을 고르세요.", main_keyboard(config), False, False
    if stripped == "/status":
        state["awaiting"] = None
        return render_status(config, state), main_keyboard(config), False, False
    if stripped == "/test":
        state["awaiting"] = None
        return "연결 확인을 보냅니다.", main_keyboard(config), False, True
    awaiting = state.get("awaiting") or ""
    if awaiting == "url:add" or awaiting.startswith("url:"):
        parsed = parse_court_address(stripped)
        if parsed is None:
            return "코트 번호 또는 예약 주소로 보내세요.", address_keyboard(config), False, False
        court_id, url = parsed
        if awaiting == "url:add":
            if _watch(config, str(court_id)) is not None:
                return "이미 감시 중인 코트입니다.", address_keyboard(config), False, False
            config.setdefault("watches", []).append(_default_watch(court_id, url))
            state["awaiting"] = None
            return f"코트 {court_id}를 추가했습니다.", address_keyboard(config), True, False
        current = _watch(config, awaiting.split(":", 1)[1])
        if current is None:
            state["awaiting"] = None
            return "코트를 찾지 못했습니다.", address_keyboard(config), False, False
        if str(current.get("id")) != str(court_id) and _watch(config, str(court_id)) is not None:
            return "이미 감시 중인 코트입니다.", address_keyboard(config), False, False
        old_id = str(current.get("id"))
        current["id"] = court_id
        current["url"] = url
        if old_id != str(court_id):
            current["name"] = f"코트 {court_id}"
            forget_courts(state, {old_id})
        state["awaiting"] = None
        return "주소를 저장했습니다.", address_keyboard(config), True, False
    if state.get("awaiting") == "sleep":
        match = SLEEP_TEXT_RE.fullmatch(stripped)
        if not match:
            return "23:30 07:00 형식으로 다시 보내세요.", sleep_keyboard(), False, False
        start = _normalize_hm(match.group(1))
        end = _normalize_hm(match.group(2))
        if start is None or end is None:
            return "시각이 올바르지 않습니다.", sleep_keyboard(), False, False
        state["awaiting"] = None
        _set_sleep(config, start, end)
        if start == end:
            return "수면 시간을 없앴습니다.", main_keyboard(config), True, False
        return f"수면 시간을 {start}-{end}으로 저장했습니다.", main_keyboard(config), True, False
    return None
