#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test delle funzioni aggiunte: ruoli, ritiro, rivalutazione, account, push.

    python3 -m unittest discover -s tests -v
"""

import http.cookiejar
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import webpush  # noqa: E402

PIN = {"giulia@studio.it": "1111", "luca@studio.it": "2222",
       "sara@studio.it": "3333", "coordinatore@studio.it": "1234"}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def future(days):
    return (date.today() + timedelta(days=days)).isoformat()


class FeatureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="ferie-features-")
        cls.port = free_port()
        cls.base = "http://127.0.0.1:%d" % cls.port
        env = dict(os.environ)
        env["DATA_DIR"] = cls.tmp.name
        env["HOST"] = "127.0.0.1"
        env["PORT"] = str(cls.port)
        for key in ("RESEND_API_KEY", "SMTP_HOST", "MAIL_FROM", "COORDINATOR_EMAILS"):
            env.pop(key, None)
        cls.proc = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py"), "serve", "--port", str(cls.port), "--no-open"],
            cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(cls.base + "/api/health", timeout=1) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.15)
        cls.proc.terminate()
        raise RuntimeError("Il server di test non si è avviato")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        cls.tmp.cleanup()

    # ------------------------------------------------------------------

    def client(self):
        return urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, opener, path, method="GET", body=None):
        data = None
        headers = {"Origin": self.base}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with opener.open(request) as response:
                return response.status, response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8")

    def json_call(self, opener, path, method="GET", body=None):
        status, text = self.call(opener, path, method, body)
        try:
            return status, json.loads(text)
        except ValueError:
            return status, text

    def login(self, email, pin=None):
        opener = self.client()
        status, data = self.json_call(opener, "/api/login", "POST",
                                      {"email": email, "pin": pin or PIN[email]})
        self.assertEqual(status, 200, data)
        return opener

    def create(self, opener, payload):
        status, data = self.json_call(opener, "/api/requests", "POST", payload)
        return status, data

    # ------------------------------------------------------------------

    def test_01_tipi_di_richiesta_per_ruolo(self):
        status, config = self.json_call(self.client(), "/api/config")
        self.assertEqual(status, 200)
        self.assertEqual(config["types_by_role"]["professionista"], ["disponibilita"])
        self.assertEqual(config["types_by_role"]["dipendente"], ["ferie", "permesso"])
        self.assertEqual(len(config["types_by_role"]["coordinatore"]), 3)

        sara = self.login("sara@studio.it")
        for kind in ("ferie", "permesso"):
            status, data = self.create(sara, {"type": kind, "dates": [future(300)]})
            self.assertEqual(status, 403, (kind, data))
        status, data = self.create(sara, {"type": "disponibilita",
                                          "availability": "non_disponibile",
                                          "dates": [future(300)]})
        self.assertEqual(status, 201, data)

        giulia = self.login("giulia@studio.it")
        status, data = self.create(giulia, {"type": "disponibilita", "availability": "disponibile",
                                           "dates": [future(301)]})
        self.assertEqual(status, 403, data)
        status, data = self.create(giulia, {"type": "ferie", "dates": [future(301)]})
        self.assertEqual(status, 201, data)

        coordinator = self.login("coordinatore@studio.it")
        status, data = self.create(coordinator, {"type": "disponibilita",
                                                "availability": "disponibile",
                                                "dates": [future(302)]})
        self.assertEqual(status, 201, data)

    def test_02_dipendente_ritira_una_richiesta_approvata(self):
        giulia = self.login("giulia@studio.it")
        coordinator = self.login("coordinatore@studio.it")
        luca = self.login("luca@studio.it")
        day = future(310)

        status, data = self.create(giulia, {"type": "ferie", "dates": [day]})
        self.assertEqual(status, 201, data)
        request_id = data["request"]["id"]

        status, data = self.json_call(coordinator, "/api/requests/%s/decision" % request_id,
                                      "POST", {"decision": "approve", "note": "Ok"})
        self.assertEqual(status, 200, data)

        status, data = self.json_call(luca, "/api/calendar?from=%s&to=%s" % (day, day))
        self.assertTrue(any(item["id"] == request_id for item in data["events"]))

        status, data = self.json_call(giulia, "/api/requests/%s/cancel" % request_id, "POST", {})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["request"]["status"], "cancelled")
        self.assertIn("Ritirata", data["request"]["decision_note"])

        status, data = self.json_call(luca, "/api/calendar?from=%s&to=%s" % (day, day))
        self.assertFalse(any(item["id"] == request_id for item in data["events"]))

        status, _ = self.json_call(giulia, "/api/requests/%s/cancel" % request_id, "POST", {})
        self.assertEqual(status, 409)

        # una richiesta rifiutata non si ritira: il dipendente non può
        status, data = self.create(giulia, {"type": "ferie", "dates": [future(311)]})
        rejected_id = data["request"]["id"]
        self.json_call(coordinator, "/api/requests/%s/decision" % rejected_id,
                       "POST", {"decision": "reject"})
        status, data = self.json_call(giulia, "/api/requests/%s/cancel" % rejected_id, "POST", {})
        self.assertEqual(status, 409, data)

    def test_03_coordinatore_rivaluta_e_riaudisce(self):
        giulia = self.login("giulia@studio.it")
        coordinator = self.login("coordinatore@studio.it")
        day = future(320)

        status, data = self.create(giulia, {"type": "ferie", "dates": [day]})
        self.assertEqual(status, 201, data)
        request_id = data["request"]["id"]

        status, data = self.json_call(coordinator, "/api/requests/%s/decision" % request_id,
                                      "POST", {"decision": "approve"})
        self.assertEqual(status, 200, data)

        # cambia idea: rifiuta una richiesta già approvata
        status, data = self.json_call(coordinator, "/api/requests/%s/decision" % request_id,
                                      "POST", {"decision": "reject", "note": "Sovrapposizione"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["request"]["status"], "rejected")
        self.assertEqual(data["request"]["decision_note"], "Sovrapposizione")

        # rimette in attesa la richiesta
        status, data = self.json_call(coordinator, "/api/requests/%s/reopen" % request_id,
                                      "POST", {})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["request"]["status"], "pending")
        self.assertIsNone(data["request"]["decided_at"])

        status, data = self.json_call(coordinator, "/api/requests/pending")
        self.assertTrue(any(item["id"] == request_id for item in data["pending"]))

        status, _ = self.json_call(coordinator, "/api/requests/%s/reopen" % request_id, "POST", {})
        self.assertEqual(status, 409)

        status, _ = self.json_call(giulia, "/api/requests/%s/reopen" % request_id, "POST", {})
        self.assertEqual(status, 403)

        # la rivalutazione manda una nuova email al richiedente
        status, data = self.json_call(coordinator, "/api/outbox")
        outcomes = [m for m in data["messages"] if m["to"] == "giulia@studio.it"]
        self.assertGreaterEqual(len(outcomes), 2)

    def test_04_coordinatore_modifica_i_propri_dati(self):
        coordinator = self.login("coordinatore@studio.it")
        status, data = self.json_call(coordinator, "/api/session")
        self.assertEqual(status, 200, data)
        self.assertEqual(data["user"]["email"], "coordinatore@studio.it")

        try:
            status, data = self.json_call(coordinator, "/api/profile", "POST",
                                          {"name": "Marco Bianchi Rossi", "email": "marco@synlab.it"})
            self.assertEqual(status, 200, data)
            self.assertEqual(data["user"]["name"], "Marco Bianchi Rossi")
            self.assertEqual(data["user"]["email"], "marco@synlab.it")

            status, data = self.json_call(coordinator, "/api/session")
            self.assertEqual(data["user"]["email"], "marco@synlab.it")

            # la sessione resta valida, il login usa la nuova email
            other = self.client()
            status, data = self.json_call(other, "/api/login", "POST",
                                          {"email": "coordinatore@studio.it", "pin": "1234"})
            self.assertEqual(status, 401, data)
            status, data = self.json_call(other, "/api/login", "POST",
                                          {"email": "marco@synlab.it", "pin": "1234"})
            self.assertEqual(status, 200, data)

            status, data = self.json_call(coordinator, "/api/profile", "POST",
                                          {"name": "Marco Bianchi", "email": "giulia@studio.it"})
            self.assertEqual(status, 409, data)

            status, data = self.json_call(coordinator, "/api/profile", "POST",
                                          {"name": "Marco Bianchi", "email": "non-una-email"})
            self.assertEqual(status, 400, data)
        finally:
            self.json_call(coordinator, "/api/profile", "POST",
                           {"name": "Marco Bianchi", "email": "coordinatore@studio.it"})

    def test_05_eliminazione_account_e_richieste(self):
        coordinator = self.login("coordinatore@studio.it")
        status, data = self.json_call(coordinator, "/api/users", "POST",
                                      {"name": "Persona Temporanea", "email": "temp@synlab.it",
                                       "role": "dipendente", "pin": "4321"})
        self.assertEqual(status, 201, data)
        user_id = data["user"]["id"]

        temp = self.login("temp@synlab.it", "4321")
        status, data = self.create(temp, {"type": "ferie", "dates": [future(330)]})
        self.assertEqual(status, 201, data)
        request_id = data["request"]["id"]

        status, data = self.json_call(coordinator, "/api/users/%s/delete" % user_id,
                                      "POST", {})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["removed_requests"], 1)

        status, data = self.json_call(coordinator, "/api/users")
        self.assertFalse(any(item["id"] == user_id for item in data["users"]))

        status, data = self.json_call(coordinator, "/api/requests/pending")
        self.assertFalse(any(item["id"] == request_id for item in data["pending"]))

        status, _ = self.json_call(self.client(), "/api/login", "POST",
                                   {"email": "temp@synlab.it", "pin": "4321"})
        self.assertEqual(status, 401)

        status, data = self.json_call(coordinator, "/api/session")
        own_id = data["user"]["id"]
        status, data = self.json_call(coordinator, "/api/users/%s/delete" % own_id, "POST", {})
        self.assertEqual(status, 400, data)

        status, _ = self.json_call(coordinator, "/api/users/u_inesistente/delete", "POST", {})
        self.assertEqual(status, 404)

        status, _ = self.json_call(self.login("giulia@studio.it"),
                                   "/api/users/%s/delete" % own_id, "POST", {})
        self.assertEqual(status, 403)

    def test_06_push_iscrizione_e_decisione(self):
        giulia = self.login("giulia@studio.it")
        coordinator = self.login("coordinatore@studio.it")

        status, _ = self.json_call(self.client(), "/api/push/key")
        self.assertEqual(status, 401)

        status, data = self.json_call(giulia, "/api/push/key")
        self.assertEqual(status, 200, data)
        public = webpush.b64url_decode(data["public_key"])
        self.assertEqual(len(public), 65)
        self.assertEqual(public[0], 4)
        self.assertTrue((Path(self.tmp.name) / "vapid.json").exists())

        private = webpush.generate_private()
        p256dh = webpush.b64url_encode(webpush.public_from_private(private))
        auth = webpush.b64url_encode(secrets.token_bytes(16))
        endpoint = "https://127.0.0.1:%d/push/demo" % self.port

        status, data = self.json_call(giulia, "/api/push/subscribe", "POST",
                                      {"endpoint": endpoint,
                                       "keys": {"p256dh": p256dh, "auth": auth}})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["devices"], 1)

        status, data = self.json_call(giulia, "/api/push/subscribe", "POST",
                                      {"endpoint": endpoint,
                                       "keys": {"p256dh": p256dh, "auth": auth}})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["devices"], 1)

        status, data = self.json_call(giulia, "/api/push/subscribe", "POST",
                                      {"endpoint": "http://non-sicuro.example/push",
                                       "keys": {"p256dh": p256dh, "auth": auth}})
        self.assertEqual(status, 400, data)

        status, data = self.json_call(giulia, "/api/push/subscribe", "POST",
                                      {"endpoint": endpoint,
                                       "keys": {"p256dh": "non-una-chiave", "auth": auth}})
        self.assertEqual(status, 400, data)

        # una decisione deve riuscire anche se il servizio push non risponde
        status, data = self.create(giulia, {"type": "ferie", "dates": [future(340)]})
        self.assertEqual(status, 201, data)
        request_id = data["request"]["id"]
        status, data = self.json_call(coordinator, "/api/requests/%s/decision" % request_id,
                                      "POST", {"decision": "approve"})
        self.assertEqual(status, 200, data)
        status, _ = self.json_call(giulia, "/api/health")
        self.assertEqual(status, 200)

        status, data = self.json_call(giulia, "/api/push/unsubscribe", "POST",
                                      {"endpoint": endpoint})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["devices"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
