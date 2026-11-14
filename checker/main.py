from __future__ import annotations

import os
import sys
from pathlib import Path

from checker.config_store import load_config, load_state, save_config, save_state
from checker.crawl import CrawlError, crawl_courts
from checker.logic import (
    acknowledge,
    acknowledge_failure,
    alert_click,
    collect_alerts,
    failure_should_send,
    is_muted,
    note_recovery,
    observed_slots,
    render_alert,
    seoul_now,
)
from checker.notify import FAILURE_TEXT, TEST_TEXT, send_ntfy

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.yaml"
STATE_PATH = ROOT / "state" / "slots.json"


def _meaningful(state: dict) -> dict:
    data = dict(state)
    data.pop("last_check", None)
    return data


def run() -> int:
    if os.environ.get("COURTWATCH_TEST", "").lower() == "true":
        if not send_ntfy(TEST_TEXT, "연결 확인", priority=3):
            print("connection test failed")
            return 1
        print("connection test sent")
        return 0

    config = load_config(CONFIG_PATH)
    state = load_state(STATE_PATH)
    loaded = _meaningful(state)
    now = seoul_now()
    config_changed = False
    muted = is_muted(config, now)
    exit_code = 0

    enabled = [watch for watch in config.get("watches", []) if watch.get("enabled", True)]
    if not enabled:
        state["open_now"] = []
        state["last_error"] = None
    else:
        try:
            calendars, renamed = crawl_courts(config, now.date())
            config_changed = renamed
            observed = observed_slots(config, calendars, now.date())
            note_recovery(state)
            alerts = collect_alerts(state, observed, muted, now.date().isoformat())
            if alerts and not muted:
                message = render_alert(config, alerts)
                if send_ntfy(message, "빈 코트", alert_click(config, alerts), priority=5):
                    acknowledge(state, alerts)
                else:
                    exit_code = 1
                    print("alert delivery failed")
        except CrawlError as exc:
            state["last_error"] = "예약 화면을 읽지 못했습니다."
            print(f"crawl failed: {exc}")
            exit_code = 1
            if failure_should_send(state, muted):
                if send_ntfy(FAILURE_TEXT, "코트 감시 실패", priority=4):
                    acknowledge_failure(state)
                else:
                    print("failure alert delivery failed")

    state["last_check"] = now.strftime("%Y-%m-%d %H:%M")
    if _meaningful(state) != loaded or config_changed:
        save_state(STATE_PATH, state)
    if config_changed:
        save_config(CONFIG_PATH, config)
    print(
        f"checked={len(enabled)} open={len(state.get('open_now') or [])} "
        f"muted={str(muted).lower()} exit={exit_code}"
    )
    return exit_code


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
