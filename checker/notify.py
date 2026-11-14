from __future__ import annotations

import os
import re

import requests

_LINK_RE = re.compile(r"(?i)(?:https?://|www\.)\S+")

FAILURE_TEXT = "예약 화면을 읽지 못했습니다. 다음 검사에서 다시 확인합니다."
TEST_TEXT = "연결 확인"


def _chunks(text: str) -> list[str]:
    if len(text) <= 3900:
        return [text]
    pieces = []
    current = ""
    for line in text.splitlines(keepends=True):
        if len(current) + len(line) > 3900:
            pieces.append(current.rstrip())
            current = line
        else:
            current += line
    if current.strip():
        pieces.append(current.rstrip())
    return pieces or [text[:3900]]


def _plain(value: str) -> str:
    lines = [" ".join(_LINK_RE.sub(" ", line).split()) for line in str(value).splitlines()]
    return "\n".join(lines).strip()


def send_ntfy(text: str, title: str, priority: int = 5) -> bool:
    text = _plain(text)
    title = _plain(title) or "빈 코트"
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        print(text)
        return False
    server = (os.environ.get("NTFY_SERVER") or "https://ntfy.sh").strip().rstrip("/")
    token = os.environ.get("NTFY_TOKEN", "").strip()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    ok = True
    parts = _chunks(text)
    for index, part in enumerate(parts):
        payload = {
            "topic": topic,
            "title": title if index == 0 else f"{title} ({index + 1})",
            "message": part,
            "priority": priority,
            "tags": ["tennis"],
        }
        try:
            response = requests.post(server, json=payload, headers=headers, timeout=30)
            response.raise_for_status()
        except requests.RequestException:
            ok = False
    return ok
