#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verifica la crittografia delle notifiche push contro i vettori di test ufficiali.

I valori attesi vengono da:
  * RFC 8291, sezione 5 e appendice A (cifratura aes128gcm)
  * FIPS-197, appendice B (AES-128)
  * RFC 7515, appendice A.3 (firma ES256)
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import webpush  # noqa: E402


class EncryptionTest(unittest.TestCase):
    ua_public = ("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyP"
                 "js7Vd8pZGH6SRpkNtoIAiw4")
    auth = "BTBZMqHH6r4Tts7J_aSIgg"

    def test_aes_block_fips197(self):
        block = webpush._aes_block(
            webpush._expand_key(bytes.fromhex("000102030405060708090a0b0c0d0e0f")),
            bytes.fromhex("00112233445566778899aabbccddeeff"))
        self.assertEqual(block.hex(), "69c4e0d86a7b0430d8cdb78070b4c55a")

    def test_rfc8291_payload(self):
        salt = webpush.b64url_decode("DGv6ra1nlYgDCS1FRnbzlw")
        sender = int.from_bytes(webpush.b64url_decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
                                "big")
        expected = ("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
                    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
                    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")
        body = webpush.encrypt(b"When I grow up, I want to be a watermelon", self.ua_public,
                               self.auth, salt=salt, sender_private=sender)
        self.assertEqual(webpush.b64url_encode(body), expected)

    def test_chiave_pubblica_del_vettore(self):
        sender = int.from_bytes(webpush.b64url_decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
                                "big")
        self.assertEqual(
            webpush.b64url_encode(webpush.public_from_private(sender)),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")

    def test_sottoscrizione_valida(self):
        p256dh, auth = webpush.subscription_keys(self.ua_public, self.auth)
        self.assertEqual(p256dh, self.ua_public)
        self.assertEqual(auth, self.auth)
        with self.assertRaises(ValueError):
            webpush.subscription_keys("non-una-chiave", self.auth)
        with self.assertRaises(ValueError):
            webpush.subscription_keys(self.ua_public, "")

    def test_payload_cifrato_diverso_ogni_volta(self):
        first = webpush.encrypt(b"ciao", self.ua_public, self.auth)
        second = webpush.encrypt(b"ciao", self.ua_public, self.auth)
        self.assertNotEqual(first, second)
        self.assertEqual(len(first[:86]), 86)


class SignatureTest(unittest.TestCase):
    def test_rfc7515_es256(self):
        x = webpush.b64url_decode("f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU")
        y = webpush.b64url_decode("x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0")
        signature = webpush.b64url_decode(
            "DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q")
        message = (b"eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQog"
                   b"Imh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ")
        self.assertTrue(webpush.ecdsa_verify(b"\x04" + x + y, message, signature))
        self.assertFalse(webpush.ecdsa_verify(b"\x04" + x + y, message + b"x", signature))

    def test_firma_e_verifica(self):
        private = webpush.generate_private()
        public = webpush.public_from_private(private)
        signature = webpush.ecdsa_sign(private, b"ferie approvate")
        self.assertEqual(len(signature), 64)
        self.assertTrue(webpush.ecdsa_verify(public, b"ferie approvate", signature))
        self.assertFalse(webpush.ecdsa_verify(public, b"ferie rifiutate", signature))

    def test_vapid_token(self):
        vapid = webpush.new_vapid("mailto:ferie@example.com")
        token = webpush.vapid_token(vapid, "https://fcm.googleapis.com/wp/123")
        header, claims, signature = token.split(".")
        public = webpush.b64url_decode(vapid["public"])
        self.assertEqual(len(public), 65)
        self.assertEqual(public[0], 4)
        self.assertTrue(webpush.ecdsa_verify(
            public, ("%s.%s" % (header, claims)).encode("ascii"),
            webpush.b64url_decode(signature)))
        import json
        payload = json.loads(webpush.b64url_decode(claims))
        self.assertEqual(payload["aud"], "https://fcm.googleapis.com")
        self.assertEqual(payload["sub"], "mailto:ferie@example.com")
        self.assertGreater(payload["exp"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
