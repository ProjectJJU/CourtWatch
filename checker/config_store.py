from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

from checker.logic import fresh_state

TIME_RE = re.compile(r"^\d{2}:\d{2}(-\d{2}:\d{2})?$")


def _represent_str(dumper: yaml.SafeDumper, data: str):
    style = '"' if TIME_RE.fullmatch(data) else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


yaml.SafeDumper.add_representer(str, _represent_str)


def ensure_config(data: dict | None) -> dict:
    config = dict(data or {})
    config.setdefault("timezone", "Asia/Seoul")
    config.setdefault("lookahead_days", 35)
    config.setdefault("alerts_enabled", True)
    config.setdefault("sleep", {"start": "02:00", "end": "02:00"})
    config.setdefault("presets", [])
    config.setdefault("watches", [])
    return config


def load_config(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    return ensure_config(data)


def save_config(path: Path, config: dict) -> None:
    text = yaml.dump(
        config,
        Dumper=yaml.SafeDumper,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    path.write_text(text, encoding="utf-8")


def ensure_state(saved: dict | None) -> dict:
    state = fresh_state()
    if isinstance(saved, dict):
        state.update(saved)
    state["slots"] = dict(state.get("slots") or {})
    state["pending"] = sorted(state.get("pending") or [])
    state["open_now"] = sorted(state.get("open_now") or [])
    return state


def load_state(path: Path) -> dict:
    saved = None
    if path.exists():
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            saved = loaded
    return ensure_state(saved)


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
