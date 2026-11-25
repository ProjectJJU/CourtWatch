from __future__ import annotations

import json
import os
from typing import Any

import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account

from checker.config_store import ensure_config, ensure_state

DATASTORE_SCOPE = "https://www.googleapis.com/auth/datastore"
COLLECTION = "courtwatch"


class StoreError(RuntimeError):
    pass


def encode_value(value: Any) -> dict:
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [encode_value(item) for item in value]}}
    if isinstance(value, dict):
        return {"mapValue": {"fields": encode_fields(value)}}
    raise StoreError(f"unsupported value type: {type(value).__name__}")


def encode_fields(data: dict) -> dict:
    return {str(key): encode_value(item) for key, item in data.items()}


def decode_value(value: dict) -> Any:
    if "nullValue" in value:
        return None
    if "booleanValue" in value:
        return bool(value["booleanValue"])
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "stringValue" in value:
        return str(value["stringValue"])
    if "arrayValue" in value:
        return [decode_value(item) for item in value["arrayValue"].get("values") or []]
    if "mapValue" in value:
        return decode_fields(value["mapValue"].get("fields") or {})
    raise StoreError("unsupported Firestore value")


def decode_fields(fields: dict) -> dict:
    return {key: decode_value(value) for key, value in fields.items()}


def commit_body(project_id: str, doc_id: str, data: dict) -> dict:
    name = (
        f"projects/{project_id}/databases/(default)/documents/{COLLECTION}/{doc_id}"
    )
    return {"writes": [{"update": {"name": name, "fields": encode_fields(data)}}]}


class RemoteStore:
    def __init__(self, info: dict):
        project = str(info.get("project_id") or "").strip()
        if not project:
            raise StoreError("FIREBASE_SERVICE_ACCOUNT has no project_id")
        self.project = project
        self._credentials = service_account.Credentials.from_service_account_info(
            info,
            scopes=[DATASTORE_SCOPE],
        )

    def _headers(self) -> dict:
        if not self._credentials.valid:
            self._credentials.refresh(Request())
        return {"Authorization": f"Bearer {self._credentials.token}"}

    def _doc_url(self, doc_id: str) -> str:
        return (
            "https://firestore.googleapis.com/v1/projects/"
            f"{self.project}/databases/(default)/documents/{COLLECTION}/{doc_id}"
        )

    def _load(self, doc_id: str) -> dict | None:
        response = requests.get(self._doc_url(doc_id), headers=self._headers(), timeout=30)
        if response.status_code == 404:
            return None
        if not response.ok:
            raise StoreError(f"Firestore read failed ({response.status_code})")
        return decode_fields(response.json().get("fields") or {})

    def _save(self, doc_id: str, data: dict) -> None:
        url = (
            "https://firestore.googleapis.com/v1/projects/"
            f"{self.project}/databases/(default)/documents:commit"
        )
        response = requests.post(
            url,
            headers={**self._headers(), "Content-Type": "application/json"},
            data=json.dumps(commit_body(self.project, doc_id, data)),
            timeout=30,
        )
        if not response.ok:
            raise StoreError(f"Firestore write failed ({response.status_code})")

    def load_config(self) -> dict | None:
        loaded = self._load("config")
        if loaded is None:
            return None
        return ensure_config(loaded)

    def save_config(self, config: dict) -> None:
        self._save("config", config)

    def load_state(self) -> dict:
        return ensure_state(self._load("state"))

    def save_state(self, state: dict) -> None:
        self._save("state", state)


def open_store() -> RemoteStore | None:
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    on_actions = os.environ.get("GITHUB_ACTIONS", "").lower() == "true"
    if not raw:
        if on_actions:
            raise StoreError("FIREBASE_SERVICE_ACCOUNT is not set")
        return None
    try:
        info = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise StoreError("FIREBASE_SERVICE_ACCOUNT is not valid JSON") from exc
    if not isinstance(info, dict):
        raise StoreError("FIREBASE_SERVICE_ACCOUNT is not a JSON object")
    return RemoteStore(info)
