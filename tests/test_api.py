#!/usr/bin/env python3
"""Test end-to-end dell'API (solo libreria standard).

    python3 -m unittest discover -s tests -v

Avvia il server su una porta libera con una cartella dati temporanea, prova
il flusso completo (richiesta → email simulata → approvazione → calendario),
i permessi, l'ICS e il riuso della connessione HTTP keep-alive.
"""

import http.client
import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIN = {"giulia@studio.it": "1111", "luca@studio.it": "2222",
       "sara@studio.it": "3333", "coordinatore@studio.it": "1234"}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="ferie-test-")
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
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        return opener

    def call(self, opener, path, method="GET", body=None, form=None):
        data = None
        headers = {"Origin": self.base}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if form is not None:
            data = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
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

    def login(self, email):
        opener = self.client()
        status, data = self.json_call(opener, "/api/login", "POST",
                                      {"email": email, "pin": PIN[email]})
        self.assertEqual(status, 200, data)
        return opener

    def get_bytes(self, opener, path):
        request = urllib.request.Request(self.base + path, headers={"Origin": self.base})
        try:
            with opener.open(request) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    # ------------------------------------------------------------------

    def test_01_login_e_permessi(self):
        status, data = self.json_call(self.client(), "/api/config")
        self.assertEqual(status, 200)
        self.assertTrue(data["demo_mode"])
        self.assertEqual(len(data["demo_accounts"]), 4)

        anonymous = self.client()
        status, _ = self.call(anonymous, "/api/calendar")
        self.assertEqual(status, 401)

        status, data = self.json_call(self.client(), "/api/login", "POST",
                                      {"email": "giulia@studio.it", "pin": "0000"})
        self.assertEqual(status, 401)

        giulia = self.login("giulia@studio.it")
        status, _ = self.json_call(giulia, "/api/requests/pending")
        self.assertEqual(status, 403)

        status, data = self.json_call(giulia, "/api/session")
        self.assertEqual(status, 200)
        self.assertEqual(data["user"]["name"], "Giulia Rossi")

    def test_02_flusso_completo(self):
        giulia = self.login("giulia@studio.it")
        coordinator = self.login("coordinatore@studio.it")
        luca = self.login("luca@studio.it")

        start = date.today() + timedelta(days=(7 - date.today().weekday()) + 7)
        days = [(start + timedelta(days=i)).isoformat() for i in range(3)]

        status, data = self.json_call(giulia, "/api/requests", "POST",
                                      {"type": "ferie", "dates": days, "note": "Test automatico"})
        self.assertEqual(status, 201, data)
        request_id = data["request"]["id"]
        self.assertTrue(data["decision_link"].endswith("") or request_id in data["decision_link"])
        token = data["decision_link"].split("t=")[1]

        # in attesa: visibile solo a chi l'ha chiesta e al coordinatore
        status, data = self.json_call(luca, "/api/calendar?from=%s&to=%s" % (days[0], days[-1]))
        self.assertEqual(status, 200)
        self.assertFalse(any(event["id"] == request_id for event in data["events"]))

        status, data = self.json_call(coordinator, "/api/requests/pending")
        self.assertTrue(any(item["id"] == request_id for item in data["pending"]))

        # il link valido funziona senza login
        anonymous = self.client()
        status, page = self.call(anonymous, "/decide/%s?t=%s" % (request_id, token))
        self.assertEqual(status, 200)
        self.assertIn("Approva", page)

        # un token errato viene rifiutato
        status, _ = self.call(anonymous, "/decide/%s?t=nonvalido" % request_id)
        self.assertEqual(status, 403)

        # GET non deve decidere: la richiesta è ancora in attesa
        status, data = self.json_call(coordinator, "/api/requests/pending")
        self.assertTrue(any(item["id"] == request_id for item in data["pending"]))

        # il link con azione apre la conferma con il pulsante evidenziato
        status, page = self.call(anonymous, "/decide/%s?t=%s&action=approve" % (request_id, token))
        self.assertEqual(status, 200)
        self.assertIn("approve is-suggested", page)

        # approvazione dal link email, senza sessione
        status, page = self.call(anonymous, "/decide/%s" % request_id, "POST",
                                 form={"t": token, "decision": "approve", "note": "Ok"})
        self.assertEqual(status, 200)
        self.assertIn("Approvata", page)

        # ora è nel calendario di tutti e nella notifica del richiedente
        status, data = self.json_call(luca, "/api/calendar?from=%s&to=%s" % (days[0], days[-1]))
        event = next((item for item in data["events"] if item["id"] == request_id), None)
        self.assertIsNotNone(event)
        self.assertEqual(event["status"], "approved")

        status, data = self.json_call(giulia, "/api/notifications")
        self.assertTrue(any(item["request_id"] == request_id and item["kind"] == "approved"
                            for item in data["notifications"]))

        # il coordinatore ha ricevuto la notifica e il dipendente l'esito
        status, data = self.json_call(coordinator, "/api/outbox")
        recipients = {message["to"] for message in data["messages"]}
        self.assertIn("coordinatore@studio.it", recipients)
        self.assertIn("giulia@studio.it", recipients)

        # l'email al coordinatore contiene i due pulsanti di conferma
        target = next(message for message in data["messages"]
                      if message["subject"].startswith("Da approvare"))
        status, html = self.call(coordinator, "/api/outbox/%s" % target["id"])
        self.assertEqual(status, 200)
        self.assertIn("action=approve", html)
        self.assertIn("action=reject", html)


        # niente doppia decisione
        status, _ = self.json_call(coordinator, "/api/requests/%s/decision" % request_id, "POST",
                                   {"decision": "reject"})
        self.assertEqual(status, 409)

    def test_03_rifiuto_non_entra_in_calendario(self):
        sara = self.login("sara@studio.it")
        coordinator = self.login("coordinatore@studio.it")
        day = (date.today() + timedelta(days=40)).isoformat()

        status, data = self.json_call(sara, "/api/requests", "POST",
                                      {"type": "disponibilita", "availability": "non_disponibile",
                                       "dates": [day], "note": "Corso"})
        self.assertEqual(status, 201, data)
        request_id = data["request"]["id"]
        token = data["decision_link"].split("t=")[1]

        status, data = self.json_call(coordinator, "/api/requests/%s/decision" % request_id, "POST",
                                      {"decision": "reject", "note": "Periodo pieno"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["request"]["status"], "rejected")

        status, data = self.json_call(sara, "/api/calendar?from=%s&to=%s" % (day, day))
        self.assertFalse(any(item["id"] == request_id for item in data["events"]))

        status, data = self.json_call(sara, "/api/notifications")
        self.assertTrue(any(item["request_id"] == request_id and item["kind"] == "rejected"
                            for item in data["notifications"]))

        # link già usato: nessuna seconda decisione
        status, page = self.call(self.client(), "/decide/%s?t=%s" % (request_id, token))
        self.assertEqual(status, 200)
        self.assertIn("Rifiutata", page)

    def test_04_validazione_e_annullamento(self):
        giulia = self.login("giulia@studio.it")
        past = (date.today() - timedelta(days=2)).isoformat()
        status, data = self.json_call(giulia, "/api/requests", "POST",
                                      {"type": "ferie", "dates": [past]})
        self.assertEqual(status, 400)

        day = (date.today() + timedelta(days=75)).isoformat()
        status, data = self.json_call(giulia, "/api/requests", "POST",
                                      {"type": "ferie", "dates": [day]})
        self.assertEqual(status, 201, data)
        request_id = data["request"]["id"]

        status, data = self.json_call(giulia, "/api/requests", "POST",
                                      {"type": "ferie", "dates": [day]})
        self.assertEqual(status, 409)

        status, data = self.json_call(giulia, "/api/requests/%s/cancel" % request_id, "POST", {})
        self.assertEqual(status, 200)
        status, data = self.json_call(giulia, "/api/requests/%s/cancel" % request_id, "POST", {})
        self.assertEqual(status, 409)

    def test_05_calendario_ics(self):
        giulia = self.login("giulia@studio.it")
        status, data = self.json_call(giulia, "/api/calendar")
        self.assertEqual(status, 200)
        path = data["ics_url"]
        status, body = self.call(giulia, path)
        self.assertEqual(status, 200)
        self.assertIn("BEGIN:VCALENDAR", body)
        self.assertIn("END:VCALENDAR", body)
        self.assertIn("Giulia Rossi", body)

        status, _ = self.call(self.client(), "/calendar.ics?t=errato")
        self.assertEqual(status, 403)

    def test_07_richieste_simultanee(self):
        """Scritture concorrenti non devono perdere richieste."""
        import threading

        results = {}
        base_day = date.today() + timedelta(days=110)

        def worker(index, email):
            opener = self.login(email)
            day = (base_day + timedelta(days=index)).isoformat()
            status, data = self.json_call(opener, "/api/requests", "POST",
                                          {"type": "ferie", "dates": [day], "note": "concorrenza"})
            results[email] = (status, data.get("request", {}).get("id"), day)

        threads = [threading.Thread(target=worker, args=(index, email))
                   for index, email in enumerate(PIN)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertEqual(len(results), len(PIN))
        self.assertTrue(all(status == 201 for status, _, _ in results.values()), results)

        coordinator = self.login("coordinatore@studio.it")
        status, data = self.json_call(coordinator, "/api/requests/pending")
        stored = {item["id"] for item in data["pending"]}
        for _, request_id, _ in results.values():
            self.assertIn(request_id, stored)

    def test_08_permesso_fascia_e_statistiche(self):
        giulia = self.login("giulia@studio.it")
        coordinator = self.login("coordinatore@studio.it")
        next_month = (date.today().replace(day=28) + timedelta(days=4)).replace(day=1)
        day = (next_month - timedelta(days=1)).isoformat()

        status, data = self.json_call(giulia, "/api/requests", "POST",
                                      {"type": "permesso", "slot": "mattina",
                                       "dates": [day], "note": "Visita medica"})
        self.assertEqual(status, 201, data)
        request = data["request"]
        self.assertEqual(request["slot"], "mattina")
        self.assertEqual(request["slot_label"], "Mattina")

        status, data = self.json_call(giulia, "/api/requests", "POST",
                                      {"type": "permesso", "slot": "sera", "dates": [day]})
        self.assertEqual(status, 400)

        status, data = self.json_call(coordinator, "/api/requests/pending")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(data["stats"]["pending"], 1)
        self.assertEqual(data["stats"]["team"], 4)
        self.assertTrue(data["stats"]["month"])
        before = data["stats"]["approved_days_month"]

        status, data = self.json_call(coordinator, "/api/requests/%s/decision" % request["id"],
                                      "POST", {"decision": "approve", "note": "Ok"})
        self.assertEqual(status, 200, data)

        status, data = self.json_call(coordinator, "/api/requests/pending")
        self.assertEqual(data["stats"]["approved_days_month"], before + 1)

    def test_09_reinvio_email_dal_registro(self):
        coordinator = self.login("coordinatore@studio.it")
        giulia = self.login("giulia@studio.it")

        status, data = self.json_call(coordinator, "/api/outbox")
        self.assertEqual(status, 200)
        self.assertTrue(data["messages"])
        target = next((message for message in data["messages"] if not message["error"]), None)
        self.assertIsNotNone(target)
        before = len(data["messages"])

        status, _ = self.json_call(giulia, "/api/outbox/%s/resend" % target["id"], "POST", {})
        self.assertEqual(status, 403)

        status, data = self.json_call(coordinator, "/api/outbox/%s/resend" % target["id"], "POST", {})
        self.assertEqual(status, 200, data)

        status, data = self.json_call(coordinator, "/api/outbox")
        self.assertEqual(len(data["messages"]), before + 1)
        self.assertEqual(data["messages"][0]["to"], target["to"])
        self.assertEqual(data["messages"][0]["subject"], target["subject"])

        status, _ = self.json_call(coordinator, "/api/outbox/m_inesistente/resend", "POST", {})
        self.assertEqual(status, 404)

    def test_10_creazione_utenti(self):
        anonymous = self.client()
        status, _ = self.call(anonymous, "/api/users")
        self.assertEqual(status, 401)

        giulia = self.login("giulia@studio.it")
        status, _ = self.json_call(giulia, "/api/users")
        self.assertEqual(status, 403)

        status, data = self.json_call(giulia, "/api/users", "POST",
                                      {"name": "Nuovo Collega", "email": "nuovo@synlab.it",
                                       "role": "dipendente", "pin": "4821"})
        self.assertEqual(status, 403)

        coordinator = self.login("coordinatore@studio.it")
        status, data = self.json_call(coordinator, "/api/users")
        self.assertEqual(status, 200)
        self.assertEqual(len(data["users"]), 4)
        self.assertIn("coordinatore", data["roles"])

        status, data = self.json_call(coordinator, "/api/users", "POST",
                                      {"name": "Nuovo Collega", "email": "nuovo@synlab.it",
                                       "role": "dipendente", "pin": "4821"})
        self.assertEqual(status, 201, data)
        created = data["user"]
        self.assertEqual(created["email"], "nuovo@synlab.it")
        self.assertEqual(created["initials"], "NC")
        self.assertNotIn("pin_hash", created)
        self.assertNotIn("salt", created)

        status, data = self.json_call(coordinator, "/api/users", "POST",
                                      {"name": "Doppione", "email": "nuovo@synlab.it",
                                       "role": "dipendente", "pin": "9999"})
        self.assertEqual(status, 409)

        status, _ = self.json_call(coordinator, "/api/users", "POST",
                                   {"name": "Pin Corto", "email": "corto@synlab.it",
                                    "role": "dipendente", "pin": "12"})
        self.assertEqual(status, 400)

        status, _ = self.json_call(coordinator, "/api/users", "POST",
                                   {"name": "Ruolo Errato", "email": "ruolo@synlab.it",
                                    "role": "amministratore", "pin": "1234"})
        self.assertEqual(status, 400)

        status, data = self.json_call(coordinator, "/api/users")
        self.assertEqual(len(data["users"]), 5)

        nuovo = self.client()
        status, data = self.json_call(nuovo, "/api/login", "POST",
                                      {"email": "nuovo@synlab.it", "pin": "4821"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["user"]["name"], "Nuovo Collega")

        status, _ = self.json_call(nuovo, "/api/users")
        self.assertEqual(status, 403)

    def test_12_fascia_oraria_personalizzata(self):
        luca = self.login("luca@studio.it")
        coordinator = self.login("coordinatore@studio.it")
        base = date.today() + timedelta(days=150)
        day = base.isoformat()

        status, data = self.json_call(luca, "/api/requests", "POST",
                                      {"type": "permesso", "slot": "orario",
                                       "time_from": "9:15", "time_to": "12:45",
                                       "dates": [day], "note": "Visita specialistica"})
        self.assertEqual(status, 201, data)
        request = data["request"]
        self.assertEqual(request["slot"], "orario")
        self.assertEqual(request["time_from"], "09:15")
        self.assertEqual(request["time_to"], "12:45")
        self.assertEqual(request["slot_label"], "09:15–12:45")

        for offset, payload in (
            (1, {"slot": "orario", "dates": [(base + timedelta(days=1)).isoformat()]}),
            (2, {"slot": "orario", "time_from": "14:00", "time_to": "13:00",
                 "dates": [(base + timedelta(days=2)).isoformat()]}),
            (3, {"slot": "orario", "time_from": "25:00", "time_to": "12:00",
                 "dates": [(base + timedelta(days=3)).isoformat()]}),
        ):
            payload["type"] = "permesso"
            status, data = self.json_call(luca, "/api/requests", "POST", payload)
            self.assertEqual(status, 400, (offset, data))

        status, data = self.json_call(coordinator, "/api/requests/%s/decision" % request["id"],
                                      "POST", {"decision": "approve", "note": "Ok"})
        self.assertEqual(status, 200, data)

        status, data = self.json_call(self.login("giulia@studio.it"),
                                      "/api/calendar?from=%s&to=%s" % (day, day))
        self.assertEqual(status, 200, data)
        event = next(item for item in data["events"] if item["id"] == request["id"])
        self.assertEqual(event["slot_label"], "09:15–12:45")
        self.assertEqual(event["time_from"], "09:15")
        self.assertEqual(event["time_to"], "12:45")

        status, data = self.json_call(coordinator, "/api/outbox")
        self.assertEqual(status, 200)
        self.assertTrue(any("09:15–12:45" in message.get("subject", "")
                            for message in data["messages"]))

        status, data = self.json_call(luca, "/api/calendar")
        self.assertEqual(status, 200)
        status, body = self.call(luca, data["ics_url"])
        self.assertEqual(status, 200)
        self.assertIn("09:15–12:45", body)

    def test_11_colori_e_foto_profilo(self):
        png = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
               "YAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
        coordinator = self.login("coordinatore@studio.it")
        status, data = self.json_call(coordinator, "/api/users")
        self.assertEqual(status, 200, data)
        self.assertIn("palette", data)
        self.assertEqual(len(data["palette"]), 12)
        palette = data["palette"]
        used = [user["color"] for user in data["users"]]
        self.assertGreaterEqual(len(set(used)), 4)

        status, data = self.json_call(coordinator, "/api/users", "POST",
                                      {"name": "Foto Prova", "email": "foto@synlab.it",
                                       "role": "dipendente", "pin": "2468",
                                       "color": "#7a59c4", "avatar": png})
        self.assertEqual(status, 201, data)
        created = data["user"]
        self.assertEqual(created["color"], "#7a59c4")
        self.assertTrue(created["avatar"].startswith("/avatar/"))
        self.assertNotIn("pin_hash", created)

        status, body = self.get_bytes(coordinator, created["avatar"])
        self.assertEqual(status, 200)
        self.assertTrue(body.startswith(b"\x89PNG"))
        status, _ = self.get_bytes(self.client(), created["avatar"])
        self.assertEqual(status, 401)

        status, data = self.json_call(coordinator, "/api/users", "POST",
                                      {"name": "Senza Foto", "email": "altra@synlab.it",
                                       "role": "dipendente", "pin": "2468"})
        self.assertEqual(status, 201, data)
        self.assertIsNone(data["user"]["avatar"])
        self.assertIn(data["user"]["color"], palette)
        self.assertNotEqual(data["user"]["color"], "#7a59c4")

        giulia = self.login("giulia@studio.it")
        status, _ = self.json_call(giulia, "/api/users/%s/appearance" % created["id"], "POST",
                                   {"color": "#2b8a9c"})
        self.assertEqual(status, 403)

        status, data = self.json_call(coordinator, "/api/users/%s/appearance" % created["id"],
                                      "POST", {"color": "#2b8a9c", "avatar": ""})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["user"]["color"], "#2b8a9c")
        self.assertIsNone(data["user"]["avatar"])
        status, _ = self.get_bytes(coordinator, created["avatar"])
        self.assertEqual(status, 404)

        status, data = self.json_call(coordinator, "/api/users/%s/appearance" % created["id"],
                                      "POST", {"color": "#000000"})
        self.assertEqual(status, 400)
        status, data = self.json_call(coordinator, "/api/users/%s/appearance" % created["id"],
                                      "POST", {"avatar": "data:image/png;base64,bm90LWltbWFnaW5l"})
        self.assertEqual(status, 400)

        status, data = self.json_call(giulia, "/api/users/%s/appearance" % created["id"],
                                      "POST", {"color": "#b0466b"})
        self.assertEqual(status, 403)

        giulia_id = self.json_call(giulia, "/api/session")[1]["user"]["id"]
        status, data = self.json_call(giulia, "/api/users/%s/appearance" % giulia_id,
                                      "POST", {"color": "#b0466b"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["user"]["color"], "#b0466b")

        status, data = self.json_call(coordinator, "/api/users", "POST",
                                      {"name": "Foto Pesante", "email": "pesante@synlab.it",
                                       "role": "dipendente", "pin": "2468",
                                       "avatar": "data:image/jpeg;base64," + "A" * 100000})
        self.assertEqual(status, 413)

    def test_06_keepalive_dopo_body_vuoto(self):
        """Un POST con corpo JSON non letto non deve corrompere la connessione."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        try:
            conn.request("POST", "/api/logout", body="{}",
                         headers={"Content-Type": "application/json", "Origin": self.base})
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 200)

            conn.request("GET", "/api/session")
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 401)

            conn.request("GET", "/api/health")
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
