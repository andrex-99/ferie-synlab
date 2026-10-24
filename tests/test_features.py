#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Test delle funzioni aggiunte: ruoli, ritiro, rivalutazione, account, push.

    python3 -m unittest discover -s tests -v
"""

import base64
import http.cookiejar
import io
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
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server  # noqa: E402
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
        # Il coordinatore non comunica la disponibilità: chiede ferie e permessi.
        self.assertEqual(config["types_by_role"]["coordinatore"], ["ferie", "permesso"])

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
        self.assertEqual(status, 403, data)
        status, data = self.create(coordinator, {"type": "permesso", "slot": "mattina",
                                                "dates": [future(303)]})
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

    def test_07_account_demo_visibili_anche_da_un_indirizzo_pubblico(self):
        request = urllib.request.Request(
            self.base + "/api/config", headers={"Host": "ferie-synlab.onrender.com"})
        with urllib.request.urlopen(request) as response:
            config = json.loads(response.read().decode("utf-8"))
        emails = [item["email"] for item in config["demo_accounts"]]
        self.assertEqual(len(emails), 4, config["demo_accounts"])
        self.assertIn("coordinatore@studio.it", emails)
        self.assertTrue(all(item["pin"] for item in config["demo_accounts"]))

    def test_08_disponibilita_linguaggio_e_invito_calendario(self):
        sara = self.login("sara@studio.it")
        coordinator = self.login("coordinatore@studio.it")
        status, data = self.create(sara, {"type": "disponibilita", "dates": [future(150), future(152)],
                                          "availability": "non_disponibile", "note": "visita"})
        self.assertEqual(status, 201, data)
        request_id = data["request"]["id"]

        # La pagina aperta dal link email chiede di prendere visione, non di approvare
        with urllib.request.urlopen(data["decision_link"]) as response:
            page = response.read().decode("utf-8")
        self.assertIn("Ho letto", page)
        self.assertIn("Segnala da rivedere", page)
        self.assertNotIn(">Approva<", page)
        self.assertIn("disponibilità", page.lower())

        status, outbox = self.json_call(coordinator, "/api/outbox")
        self.assertEqual(status, 200, outbox)
        notice = next(message for message in outbox["messages"]
                      if message["to"] == "coordinatore@studio.it")
        self.assertTrue(notice["subject"].startswith("Disponibilità non disponibile"), notice["subject"])
        self.assertFalse(notice["subject"].startswith("Da approvare"), notice["subject"])
        status, html = self.call(coordinator, "/api/outbox/%s" % notice["id"])
        self.assertIn("ha comunicato la sua disponibilità", html)

        status, data = self.json_call(coordinator, "/api/requests/%s/decision" % request_id,
                                      "POST", {"decision": "approve"})
        self.assertEqual(status, 200, data)
        status, outbox = self.json_call(coordinator, "/api/outbox")
        outcome = outbox["messages"][0]
        self.assertEqual(outcome["to"], "sara@studio.it")
        # Non è un'approvazione: è una conferma di lettura
        self.assertTrue(outcome["subject"].startswith("✓ Comunicazione letta"), outcome["subject"])
        self.assertNotIn("approvat", outcome["subject"].lower())
        self.assertEqual(outcome["attachments"], 0)
        status, html = self.call(coordinator, "/api/outbox/%s" % outcome["id"])
        self.assertIn("preso visione", html)
        self.assertNotIn("è stata approvata", html)

    def test_09_periodi_non_contigui(self):
        days = [server.parse_day(day) for day in ("2026-11-03", "2026-11-04", "2026-11-10")]
        label = server.fmt_dates(days)
        self.assertIn("3\u20134", label, label)
        self.assertIn("10", label, label)
        self.assertIn(" e ", label, label)
        self.assertNotIn("3\u201310", label)

        ics = server.request_ics({"id": "r_prova", "type": "ferie", "note": "",
                                 "dates": ["2026-11-03", "2026-11-04", "2026-11-10"]},
                                {"name": "Giulia Rossi"})
        self.assertEqual(ics.count("BEGIN:VEVENT"), 2)
        self.assertIn("DTSTART;VALUE=DATE:20261103", ics)
        self.assertIn("DTEND;VALUE=DATE:20261105", ics)
        self.assertIn("DTSTART;VALUE=DATE:20261110", ics)
        self.assertIn("DTEND;VALUE=DATE:20261111", ics)

    def test_10_url_pubblico_https_dietro_un_proxy(self):
        request = urllib.request.Request(
            self.base + "/api/config",
            headers={"X-Forwarded-Proto": "https", "Host": "ferie-synlab.onrender.com"})
        with urllib.request.urlopen(request) as response:
            config = json.loads(response.read().decode("utf-8"))
        self.assertEqual(config["base_url"], "https://ferie-synlab.onrender.com")

        status, config = self.json_call(self.client(), "/api/config")
        self.assertEqual(status, 200)
        self.assertTrue(config["base_url"].startswith("http://"), config["base_url"])

    def test_11_disponibilita_con_fascia_oraria(self):
        sara = self.login("sara@studio.it")
        coordinator = self.login("coordinatore@studio.it")
        day = future(160)

        status, data = self.create(sara, {"type": "disponibilita", "availability": "disponibile",
                                          "dates": [day], "slot": "orario",
                                          "time_from": "8:00", "time_to": "13:00"})
        self.assertEqual(status, 201, data)
        request = data["request"]
        self.assertEqual(request["slot"], "orario")
        self.assertEqual(request["slot_label"], "08:00–13:00")

        # La fascia compare nell'email al coordinatore, non solo il giorno
        status, outbox = self.json_call(coordinator, "/api/outbox")
        notice = next(message for message in outbox["messages"]
                      if message["to"] == "coordinatore@studio.it")
        status, html = self.call(coordinator, "/api/outbox/%s" % notice["id"])
        self.assertIn("08:00–13:00", html)

        # E nella conferma di lettura che riceve il professionista
        status, data = self.json_call(coordinator, "/api/requests/%s/decision" % request["id"],
                                      "POST", {"decision": "approve"})
        self.assertEqual(status, 200, data)
        status, outbox = self.json_call(coordinator, "/api/outbox")
        outcome = outbox["messages"][0]
        status, html = self.call(coordinator, "/api/outbox/%s" % outcome["id"])
        self.assertIn("08:00–13:00", html)

        # Un orario incoerente viene rifiutato
        status, data = self.create(sara, {"type": "disponibilita", "availability": "disponibile",
                                          "dates": [future(163)], "slot": "orario",
                                          "time_from": "13:00", "time_to": "09:00"})
        self.assertEqual(status, 400, data)

        # La giornata intera resta il comportamento predefinito
        status, data = self.create(sara, {"type": "disponibilita", "availability": "non_disponibile",
                                          "dates": [future(164)]})
        self.assertEqual(status, 201, data)
        self.assertEqual(data["request"]["slot"], "giornata")

    def test_12_riepilogo_settimanale_solo_per_coordinatori(self):
        # L'endpoint esiste ed è riservato al coordinatore.
        giulia = self.login("giulia@studio.it")
        status, data = self.json_call(giulia, "/api/weekly-digest", "POST", {})
        self.assertEqual(status, 403, data)

        coordinator = self.login("coordinatore@studio.it")
        status, data = self.json_call(coordinator, "/api/weekly-digest", "POST", {})
        # In demo il riepilogo viene comunque generato e salvato nel registro:
        # così il messaggio si può leggere senza configurare un provider.
        self.assertEqual(status, 200, data)
        self.assertTrue(data["simulated"])
        self.assertEqual(data["sent"], 1)
        self.assertEqual(data["recipients"], ["coordinatore@studio.it"])
        self.assertIn("Settimana prossima", data["subject"])

        status, outbox = self.json_call(coordinator, "/api/outbox")
        self.assertEqual(status, 200, outbox)
        self.assertFalse(outbox["configured"])
        mail = outbox["messages"][0]
        self.assertEqual(mail["provider"], "demo")
        self.assertEqual(mail["to"], "coordinatore@studio.it")
        self.assertEqual(mail["subject"], data["subject"])

        # E l'HTML del riepilogo è consultabile dal registro.
        status, page = self.call(coordinator, "/api/outbox/%s" % mail["id"])
        self.assertEqual(status, 200)
        self.assertIn("Riepilogo settimanale", page)

        # L'utente normale non vede né il registro né il riepilogo.
        status, _ = self.json_call(giulia, "/api/outbox")
        self.assertEqual(status, 403)

    def test_13_compleanno_sul_calendario_condiviso(self):
        giulia = self.login("giulia@studio.it")
        luca = self.login("luca@studio.it")

        # Il compleanno si imposta dal proprio profilo, senza anno.
        status, data = self.json_call(giulia, "/api/profile", "POST",
                                      {"name": "Giulia Rossi", "email": "giulia@studio.it",
                                       "birthday": "02-29"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["user"]["birthday"], "02-29")

        # Lo vede tutto il team e compare solo nel periodo richiesto.
        status, calendar = self.json_call(luca, "/api/calendar?from=2028-02-01&to=2028-03-05")
        self.assertEqual(status, 200, calendar)
        leap = [item for item in calendar["birthdays"] if item["user_name"] == "Giulia Rossi"]
        self.assertEqual(len(leap), 1, calendar["birthdays"])
        self.assertEqual(leap[0]["date"], "2028-02-29")
        self.assertEqual(leap[0]["day_month"], "02-29")

        # Negli anni non bisestili il 29 febbraio cade il 28.
        status, calendar = self.json_call(luca, "/api/calendar?from=2029-02-01&to=2029-03-05")
        dates = [item["date"] for item in calendar["birthdays"] if item["user_name"] == "Giulia Rossi"]
        self.assertEqual(dates, ["2029-02-28"])

        status, calendar = self.json_call(luca, "/api/calendar?from=2028-03-01&to=2028-03-31")
        self.assertFalse([item for item in calendar["birthdays"] if item["user_name"] == "Giulia Rossi"])

        # Una data inesistente viene rifiutata.
        status, data = self.json_call(giulia, "/api/profile", "POST",
                                      {"name": "Giulia Rossi", "email": "giulia@studio.it",
                                       "birthday": "02-30"})
        self.assertEqual(status, 400, data)

        # Aggiornare nome ed email senza toccare il compleanno lo conserva.
        status, data = self.json_call(giulia, "/api/profile", "POST",
                                      {"name": "Giulia Rossi", "email": "giulia@studio.it"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["user"]["birthday"], "02-29")

        # E si può togliere lasciando vuoto il campo.
        status, data = self.json_call(giulia, "/api/profile", "POST",
                                      {"name": "Giulia Rossi", "email": "giulia@studio.it",
                                       "birthday": ""})
        self.assertEqual(status, 200, data)
        self.assertIsNone(data["user"]["birthday"])

    def test_14_giorno_del_riepilogo_personalizzabile(self):
        giulia = self.login("giulia@studio.it")
        coordinator = self.login("coordinatore@studio.it")

        # Solo il coordinatore può spostare il riepilogo.
        status, data = self.json_call(giulia, "/api/weekly-digest/settings", "POST", {"weekday": 2})
        self.assertEqual(status, 403, data)

        status, data = self.json_call(coordinator, "/api/weekly-digest/settings", "POST", {"weekday": 7})
        self.assertEqual(status, 400, data)

        status, config = self.json_call(coordinator, "/api/config")
        self.assertEqual(config["weekly_digest"]["weekday"], 3)  # default: giovedì
        self.assertFalse(config["weekly_digest"]["custom_weekday"])
        # In demo il giorno si può scegliere lo stesso: manca solo l'invio
        # automatico, che richiede un servizio email.
        self.assertTrue(config["weekly_digest"]["available"])
        self.assertFalse(config["weekly_digest"]["enabled"])

        status, data = self.json_call(coordinator, "/api/weekly-digest/settings", "POST", {"weekday": 2})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["weekly_digest"]["weekday"], 2)
        self.assertEqual(data["weekly_digest"]["weekday_label"], "mercoledì")

        # La scelta vale per tutto il team, anche per chi non l'ha impostata.
        status, config = self.json_call(giulia, "/api/config")
        self.assertEqual(config["weekly_digest"]["weekday"], 2)
        self.assertTrue(config["weekly_digest"]["custom_weekday"])

        # Riporta il default per lasciare l'ambiente come l'abbiamo trovato.
        status, _ = self.json_call(coordinator, "/api/weekly-digest/settings", "POST", {"weekday": 3})
        self.assertEqual(status, 200)

    def test_15_area_amministratore_solo_diagnostica(self):
        coordinator = self.login("coordinatore@studio.it")
        giulia = self.login("giulia@studio.it")

        status, data = self.json_call(coordinator, "/api/users", "POST",
                                      {"name": "Tecnico Demo", "email": "admin@studio.it",
                                       "role": "admin", "pin": "5555"})
        self.assertEqual(status, 201, data)
        self.assertTrue(data["user"]["admin"])
        self.assertEqual(data["user"]["role"], "admin")

        admin = self.login("admin@studio.it", "5555")
        status, session = self.json_call(admin, "/api/session")
        self.assertEqual(status, 200)
        self.assertTrue(session["user"]["admin"])
        self.assertEqual(session["allowed_types"], [])

        status, diag = self.json_call(admin, "/api/admin/diagnostics")
        self.assertEqual(status, 200, diag)
        for key in ("server", "storage", "counts", "email", "push", "logs", "errors", "outbox_recent"):
            self.assertIn(key, diag)
        self.assertEqual(diag["email"]["provider"], "demo")
        self.assertIsInstance(diag["logs"], list)
        self.assertGreaterEqual(diag["counts"]["users"], 5)

        # Sola lettura: niente richieste, decisioni o nuovi accessi.
        status, data = self.create(admin, {"type": "ferie", "dates": [future(400)]})
        self.assertEqual(status, 403, data)
        self.assertIn("non può inviare", data["error"])

        status, data = self.create(giulia, {"type": "ferie", "dates": [future(401)]})
        self.assertEqual(status, 201, data)
        pending_id = data["request"]["id"]
        status, data = self.json_call(admin, "/api/requests/%s/decision" % pending_id, "POST",
                                      {"decision": "approve"})
        self.assertEqual(status, 403, data)
        status, data = self.json_call(admin, "/api/requests/pending")
        self.assertEqual(status, 403, data)
        status, data = self.json_call(admin, "/api/users", "POST",
                                      {"name": "Altro", "email": "altro@studio.it",
                                       "role": "dipendente", "pin": "6666"})
        self.assertEqual(status, 403, data)

        # Può consultare il registro email, ma non reinviare né fare prove.
        status, data = self.json_call(admin, "/api/outbox")
        self.assertEqual(status, 200, data)
        status, _ = self.json_call(admin, "/api/outbox/x/resend", "POST", {})
        self.assertEqual(status, 403)
        status, _ = self.json_call(admin, "/api/test-email", "POST", {})
        self.assertEqual(status, 403)

        # La diagnostica resta chiusa a chi non è amministratore.
        status, data = self.json_call(giulia, "/api/admin/diagnostics")
        self.assertEqual(status, 403, data)


class MailjetTest(unittest.TestCase):
    """Invio via Mailjet: API HTTPS con due chiavi, senza SMTP."""

    class FakeResponse:
        def read(self):
            return b'{"Messages": [{"Status": "success"}]}'

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def test_provider_scelto_per_priorita(self):
        with mock.patch.multiple(server, RESEND_API_KEY="", MAILJET_API_KEY="k",
                                 MAILJET_SECRET_KEY="s", MAIL_FROM="ferie@studio.it",
                                 SMTP_HOST=""):
            self.assertEqual(server.email_provider(), "mailjet")
            self.assertTrue(server.email_configured())
            # Con la chiave pubblica ma senza quella privata non si invia.
            with mock.patch.object(server, "MAILJET_SECRET_KEY", ""):
                self.assertEqual(server.email_provider(), "demo")
                self.assertFalse(server.email_configured())

    def test_errore_del_provider_riportato(self):
        # Senza questo, il registro direbbe solo «HTTP Error 401» senza il motivo.
        def fake_urlopen(request, timeout=0):
            raise urllib.error.HTTPError(
                "https://api.mailjet.com/v3.1/send", 401, "Unauthorized", {},
                io.BytesIO(b'{"ErrorMessage": "sender not validated"}'))

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(RuntimeError) as failure:
                server.post_json("https://api.mailjet.com/v3.1/send", {}, {})
        self.assertIn("401", str(failure.exception))
        self.assertIn("sender not validated", str(failure.exception))

    def test_invio_con_allegato_ics(self):
        captured = {}

        def fake_urlopen(request, timeout=0):
            captured["url"] = request.full_url
            captured["auth"] = request.get_header("Authorization")
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return self.FakeResponse()

        db = {"users": [], "requests": [], "outbox": [], "meta": {}}
        with tempfile.TemporaryDirectory() as outbox_dir, \
                mock.patch.multiple(
                    server, RESEND_API_KEY="", MAILJET_API_KEY="pub",
                    MAILJET_SECRET_KEY="priv", MAIL_FROM="ferie@studio.it",
                    MAIL_FROM_NAME="Synlab", MAIL_REPLY_TO="", SMTP_HOST="",
                    OUTBOX_DIR=Path(outbox_dir),
                    load_db=mock.Mock(side_effect=lambda: db), save_db=mock.Mock()), \
                mock.patch("urllib.request.urlopen", fake_urlopen):
            entry = server.send_mail("giulia@studio.it", "Esito", "<p>ok</p>", "ok",
                                     attachments=[("ferie.ics", "QUJD")],
                                     reply_to="giulia@studio.it", idempotency_key="digest-1")

        self.assertEqual(entry["provider"], "mailjet")
        self.assertIsNone(entry["error"])
        self.assertEqual(captured["url"], "https://api.mailjet.com/v3.1/send")
        self.assertEqual(captured["auth"],
                         "Basic " + base64.b64encode(b"pub:priv").decode("ascii"))
        message = captured["body"]["Messages"][0]
        self.assertEqual(message["From"], {"Email": "ferie@studio.it", "Name": "Synlab"})
        self.assertEqual(message["To"], [{"Email": "giulia@studio.it"}])
        self.assertEqual(message["Subject"], "Esito")
        self.assertEqual(message["HTMLPart"], "<p>ok</p>")
        self.assertEqual(message["TextPart"], "ok")
        self.assertEqual(message["ReplyTo"], {"Email": "giulia@studio.it"})
        self.assertEqual(message["CustomID"], "digest-1")
        self.assertEqual(message["Attachments"][0]["Filename"], "ferie.ics")
        self.assertEqual(message["Attachments"][0]["Base64Content"], "QUJD")


class AdminPolicyTest(unittest.TestCase):
    def test_promozione_tramite_variabile_admin_emails(self):
        user = {"role": "dipendente", "email": "capo@studio.it"}
        self.assertFalse(server.is_admin(user))
        with mock.patch.object(server, "ADMIN_EMAILS", ["capo@studio.it"]):
            self.assertTrue(server.is_admin(user))
            self.assertFalse(server.is_admin({"role": "dipendente", "email": "altro@studio.it"}))
        self.assertTrue(server.is_admin({"role": "admin", "email": "x@y.it"}))
        self.assertFalse(server.is_admin(None))


class WeeklyDigestTest(unittest.TestCase):
    """Riepilogo delle assenze della settimana prossima (funzioni, senza server)."""

    def setUp(self):
        self.db = {
            "users": [
                {"id": "u_g", "name": "Giulia Rossi", "email": "giulia@studio.it", "role": "dipendente"},
                {"id": "u_l", "name": "Luca Ferrari", "email": "luca@studio.it", "role": "dipendente"},
                {"id": "u_s", "name": "Sara Conti", "email": "sara@studio.it", "role": "professionista"},
                {"id": "u_c", "name": "Marco Bianchi", "email": "coordinatore@studio.it", "role": "coordinatore"},
            ],
            "requests": [
                {"id": "r_1", "user_id": "u_g", "type": "ferie", "dates": ["2026-10-27", "2026-10-28"],
                 "status": "approved"},
                {"id": "r_2", "user_id": "u_s", "type": "permesso", "dates": ["2026-10-29"],
                 "slot": "orario", "time_from": "08:00", "time_to": "13:00", "status": "approved"},
                {"id": "r_3", "user_id": "u_l", "type": "ferie", "dates": ["2026-10-27"],
                 "status": "pending"},
                {"id": "r_4", "user_id": "u_s", "type": "disponibilita", "availability": "disponibile",
                 "dates": ["2026-10-27"], "status": "approved"},
                {"id": "r_5", "user_id": "u_l", "type": "ferie", "dates": ["2026-10-26"],
                 "status": "cancelled"},
            ],
            "meta": {},
        }

    def test_13_raggruppa_le_assenze_approvate_per_giorno(self):
        start, end = server.next_week_bounds(date(2026, 10, 22))  # giovedì
        self.assertEqual((start.isoformat(), end.isoformat()), ("2026-10-26", "2026-11-01"))

        rows = server.weekly_absences(self.db, start, end)
        days = [row["day"].isoformat() for row in rows]
        # Solo ferie e permessi approvati: fuori la richiesta in attesa, la
        # disponibilità e quella annullata.
        self.assertEqual(days, ["2026-10-27", "2026-10-28", "2026-10-29"])
        self.assertEqual([user["name"] for user, _req in rows[0]["entries"]], ["Giulia Rossi"])

        subject, html, text = server.weekly_digest_email(rows, start, end, "https://esempio.it")
        self.assertEqual(subject, "3 assenze programmate la settimana prossima · 26 ottobre – 1 novembre 2026")
        self.assertIn("Giulia Rossi", html)
        self.assertIn("Sara Conti", html)
        self.assertGreaterEqual(html.count("08:00–13:00"), 1)
        self.assertNotIn("Luca Ferrari", html)
        self.assertIn("In totale: Giulia Rossi 2 giorni, Sara Conti 1 giorno.", html)
        self.assertIn("martedì 27 ottobre", text)
        self.assertIn("https://esempio.it/", text)

    def test_14_invia_ai_coordinatori(self):
        with mock.patch.object(server, "email_configured", return_value=True), \
                mock.patch.object(server, "send_mail", return_value={"error": None}) as mailer:
            result = server.deliver_weekly_digest(self.db, datetime(2026, 10, 22, 8, 0))

        self.assertEqual(result["sent"], 1)
        self.assertEqual(result["recipients"], ["coordinatore@studio.it"])
        to, subject, html, text = mailer.call_args.args[:4]
        self.assertEqual(to, "coordinatore@studio.it")
        self.assertIn("3 assenze programmate", subject)
        self.assertIn("permesso", html.lower())
        self.assertIn("Giulia Rossi", text)
        self.assertEqual(mailer.call_args.kwargs["idempotency_key"], "digest-2026-10-26-u_c")

    def runtime_patches(self):
        return mock.patch.multiple(
            server, email_configured=mock.Mock(return_value=True),
            load_db=mock.Mock(side_effect=lambda: self.db),
            save_db=mock.Mock(), send_mail=mock.Mock(return_value={"error": None}))

    def test_15_una_sola_volta_a_settimana_giovedi_mattina(self):
        with self.runtime_patches():
            # Giovedì prima delle 8: niente da fare
            early = server.run_weekly_digest(now=datetime(2026, 10, 22, 7, 30))
            self.assertEqual(early["sent"], 0)
            self.assertTrue(early["skipped"])

            sent = server.run_weekly_digest(now=datetime(2026, 10, 22, 8, 30))
            self.assertEqual(sent["sent"], 1)
            self.assertEqual(self.db["meta"]["weekly_digest_week"], "2026-10-26")

            # Un riavvio lo stesso giorno non deve inviare di nuovo
            again = server.run_weekly_digest(now=datetime(2026, 10, 22, 15, 0))
            self.assertEqual(again["sent"], 0)

            # Se il server era spento giovedì, il riepilogo parte al primo
            # controllo utile della settimana seguente (venerdì mattina).
            self.db["meta"] = {}
            late = server.run_weekly_digest(now=datetime(2026, 10, 23, 9, 0))
            self.assertEqual(late["sent"], 1)

            # Nessuna assenza: non si invia un'email vuota.
            self.db["meta"] = {}
            self.db["requests"] = []
            empty = server.run_weekly_digest(now=datetime(2026, 10, 29, 9, 0))
            self.assertEqual(empty["sent"], 0)
            self.assertIn("nessuna assenza", empty["skipped"])

    def test_16_giorno_del_riepilogo_scelto_dai_coordinatore(self):
        with self.runtime_patches():
            # Sabato scelto dal coordinatore: mercoledì non parte nulla.
            self.db["meta"] = {"weekly_digest_weekday": 5}
            not_yet = server.run_weekly_digest(now=datetime(2026, 10, 21, 9, 0))
            self.assertEqual(not_yet["sent"], 0)

            # Spostato al mercoledì, parte mercoledì mattina e una sola volta.
            self.db["meta"] = {"weekly_digest_weekday": 2}
            sent = server.run_weekly_digest(now=datetime(2026, 10, 21, 8, 5))
            self.assertEqual(sent["sent"], 1)
            self.assertEqual(self.db["meta"]["weekly_digest_week"], "2026-10-26")
            self.assertEqual(self.db["meta"]["weekly_digest_weekday"], 2)

            again = server.run_weekly_digest(now=datetime(2026, 10, 22, 9, 0))
            self.assertEqual(again["sent"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
