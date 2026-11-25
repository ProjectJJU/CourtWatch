from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from checker.config_store import load_config, load_state, save_config, save_state
from checker.remote_store import StoreError, open_store
from checker.crawl import CrawlError, crawl_courts
from checker.logic import (
    acknowledge,
    acknowledge_failure,
    collect_alerts,
    failure_should_send,
    is_muted,
    is_status_command,
    needs_state_save,
    note_recovery,
    observed_slots,
    render_alert,
    render_open_now,
    seoul_now,
)
from checker.notify import FAILURE_TEXT, TEST_TEXT, poll_messages, send_ntfy

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.yaml"
STATE_PATH = ROOT / "state" / "slots.json"


def run() -> int:
    if os.environ.get("COURTWATCH_TEST", "").lower() == "true":
        if not send_ntfy(TEST_TEXT, "연결 확인", priority=3):
            print("connection test failed")
            return 1
        print("connection test sent")
        return 0

    try:
        store = open_store()
    except StoreError as exc:
        print(exc)
        return 1
    if store is None:
        config = load_config(CONFIG_PATH)
        state = load_state(STATE_PATH)
    else:
        config = store.load_config()
        if config is None:
            config = load_config(CONFIG_PATH)
            store.save_config(config)
        state = store.load_state()
    previous = json.loads(json.dumps(state))
    now = seoul_now()
    config_changed = False
    muted = is_muted(config, now)
    exit_code = 0

    enabled = [watch for watch in config.get("watches", []) if watch.get("enabled", True)]
    crawled = False
    if not enabled:
        state["open_now"] = []
        state["last_error"] = None
        crawled = True
    else:
        try:
            calendars, renamed = crawl_courts(config, now.date())
            config_changed = renamed
            observed = observed_slots(config, calendars, now.date())
            note_recovery(state)
            alerts = collect_alerts(state, observed, muted, now.date().isoformat())
            crawled = True
            if alerts and not muted:
                message = render_alert(config, alerts)
                if send_ntfy(message, "빈 코트", priority=5):
                    acknowledge(state, alerts)
                else:
                    exit_code = 1
                    print("alert delivery failed")
        except CrawlError:
            state["last_error"] = "예약 화면을 읽지 못했습니다."
            print("crawl failed")
            exit_code = 1
            if failure_should_send(state, muted):
                if send_ntfy(FAILURE_TEXT, "코트 감시 실패", priority=4):
                    acknowledge_failure(state)
                else:
                    print("failure alert delivery failed")

    cursor = str(state.get("ntfy_cursor") or "").strip() or str(int(now.timestamp()) - 900)
    messages, polled = poll_messages(cursor)
    asked = polled and any(
        is_status_command(str(item.get("title") or ""), str(item.get("message") or ""))
        for item in messages
    )
    if asked:
        if crawled:
            reply = render_open_now(config, state.get("open_now") or [])
        else:
            reply = FAILURE_TEXT
        if send_ntfy(reply, "지금 빈 시간", priority=4):
            pass
        else:
            polled = False
            exit_code = 1
            print("status reply failed")
    if polled:
        if messages:
            state["ntfy_cursor"] = str(messages[-1].get("id") or cursor)
        elif not state.get("ntfy_cursor"):
            state["ntfy_cursor"] = str(int(now.timestamp()))

    state["last_check"] = now.strftime("%Y-%m-%d %H:%M:%S")
    if needs_state_save(previous, state) or config_changed:
        if store is None:
            save_state(STATE_PATH, state)
        else:
            store.save_state(state)
    if config_changed:
        if store is None:
            save_config(CONFIG_PATH, config)
        else:
            store.save_config(config)
    print(
        f"checked={len(enabled)} open={len(state.get('open_now') or [])} "
        f"muted={str(muted).lower()} exit={exit_code}"
    )
    return exit_code


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
