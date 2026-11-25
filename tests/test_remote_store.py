import json
import os
import unittest

from checker.remote_store import (
    StoreError,
    commit_body,
    decode_fields,
    encode_fields,
    open_store,
)


class CodecTests(unittest.TestCase):
    def test_round_trip(self):
        payload = {
            "alerts_enabled": True,
            "lookahead_days": 35,
            "sleep": {"start": "02:00", "end": "06:00"},
            "watches": [{"id": 73, "enabled": False, "name": "시민C"}],
            "note": None,
            "slots": {"73|2026-11-25|18:00-20:00": False},
        }
        restored = decode_fields(encode_fields(payload))
        self.assertEqual(restored, payload)
        self.assertIs(restored["alerts_enabled"], True)
        self.assertIs(restored["watches"][0]["enabled"], False)
        self.assertIsInstance(restored["lookahead_days"], int)
        self.assertIsNone(restored["note"])

    def test_commit_replaces_the_document(self):
        body = commit_body("court-watch-app", "state", {"open_now": []})
        write = body["writes"][0]
        self.assertNotIn("updateMask", write)
        self.assertTrue(write["update"]["name"].endswith("/documents/courtwatch/state"))


class OpenStoreTests(unittest.TestCase):
    def setUp(self):
        self._saved = {
            key: os.environ.get(key)
            for key in ("FIREBASE_SERVICE_ACCOUNT", "GITHUB_ACTIONS")
        }

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_missing_secret_uses_files_locally(self):
        os.environ.pop("FIREBASE_SERVICE_ACCOUNT", None)
        os.environ.pop("GITHUB_ACTIONS", None)
        self.assertIsNone(open_store())

    def test_actions_without_secret_fails(self):
        os.environ.pop("FIREBASE_SERVICE_ACCOUNT", None)
        os.environ["GITHUB_ACTIONS"] = "true"
        with self.assertRaises(StoreError):
            open_store()

    def test_invalid_json_fails(self):
        os.environ["FIREBASE_SERVICE_ACCOUNT"] = "{not json"
        os.environ.pop("GITHUB_ACTIONS", None)
        with self.assertRaises(StoreError):
            open_store()

    def test_missing_project_fails(self):
        os.environ["FIREBASE_SERVICE_ACCOUNT"] = json.dumps({"client_email": "a@b.c"})
        os.environ.pop("GITHUB_ACTIONS", None)
        with self.assertRaises(StoreError):
            open_store()
