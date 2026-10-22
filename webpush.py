#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Web Push senza dipendenze esterne
=================================

Implementa solo ciò che serve per inviare una notifica push a un telefono:

  * P-256 (ECDH, ECDSA/VAPID)
  * HKDF-SHA256
  * AES-128-GCM
  * cifratura `aes128gcm` di RFC 8291

Riferimenti: RFC 8291 (cifratura), RFC 8292 (VAPID), RFC 8188 (content coding).
Il codice è verificato contro i vettori di test ufficiali in tests/test_webpush.py.

Non è una libreria crittografica generica: è volutamente minimale e serve solo
a firmare il token VAPID e a cifrare un singolo record di push.
"""

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

# --------------------------------------------------------------------------
# Base64url senza padding
# --------------------------------------------------------------------------


def b64url_encode(data):
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(text):
    value = str(text or "").strip()
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


# --------------------------------------------------------------------------
# AES-128 (solo cifratura) e AES-128-GCM
# --------------------------------------------------------------------------

_SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76"
    "ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d83115"
    "04c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f84"
    "53d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa8"
    "51a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d1973"
    "60814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479"
    "e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a"
    "703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df"
    "8ca1890dbfe6426841992d0fb054bb16"
)

_RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36)


def _xtime(value):
    value <<= 1
    if value & 0x100:
        value = (value ^ 0x1B) & 0xFF
    return value


def _expand_key(key):
    words = [list(key[4 * i:4 * i + 4]) for i in range(4)]
    for index in range(4, 44):
        temp = list(words[index - 1])
        if index % 4 == 0:
            temp = temp[1:] + temp[:1]
            temp = [_SBOX[byte] for byte in temp]
            temp[0] ^= _RCON[index // 4 - 1]
        words.append([words[index - 4][i] ^ temp[i] for i in range(4)])
    return words


def _add_round_key(state, words, round_index):
    for column in range(4):
        word = words[round_index * 4 + column]
        for row in range(4):
            state[row][column] ^= word[row]


def _sub_bytes(state):
    for row in range(4):
        for column in range(4):
            state[row][column] = _SBOX[state[row][column]]


def _shift_rows(state):
    for row in range(1, 4):
        state[row] = state[row][row:] + state[row][:row]


def _mix_columns(state):
    for column in range(4):
        a = [state[row][column] for row in range(4)]
        total = a[0] ^ a[1] ^ a[2] ^ a[3]
        state[0][column] ^= total ^ _xtime(a[0] ^ a[1])
        state[1][column] ^= total ^ _xtime(a[1] ^ a[2])
        state[2][column] ^= total ^ _xtime(a[2] ^ a[3])
        state[3][column] ^= total ^ _xtime(a[3] ^ a[0])


def _aes_block(words, block):
    state = [[block[row + 4 * column] for column in range(4)] for row in range(4)]
    _add_round_key(state, words, 0)
    for round_index in range(1, 10):
        _sub_bytes(state)
        _shift_rows(state)
        _mix_columns(state)
        _add_round_key(state, words, round_index)
    _sub_bytes(state)
    _shift_rows(state)
    _add_round_key(state, words, 10)
    return bytes(state[row][column] for column in range(4) for row in range(4))


def _gf_multiply(x, y):
    """Moltiplicazione in GF(2^128) con il polinomio di GCM."""
    result = 0
    value = y
    for bit in range(128):
        if x & (1 << (127 - bit)):
            result ^= value
        if value & 1:
            value = (value >> 1) ^ 0xE1000000000000000000000000000000
        else:
            value >>= 1
    return result


def _ghash(hash_key, aad, ciphertext):
    data = aad + b"\x00" * (-len(aad) % 16)
    data += ciphertext + b"\x00" * (-len(ciphertext) % 16)
    data += (len(aad) * 8).to_bytes(8, "big") + (len(ciphertext) * 8).to_bytes(8, "big")
    value = 0
    for index in range(0, len(data), 16):
        block = int.from_bytes(data[index:index + 16], "big")
        value = _gf_multiply(value ^ block, hash_key)
    return value.to_bytes(16, "big")


def aes_gcm_encrypt(key, nonce, plaintext, aad=b""):
    """Restituisce (ciphertext, tag) per AES-128-GCM con nonce di 12 byte."""
    words = _expand_key(key)
    hash_key = int.from_bytes(_aes_block(words, b"\x00" * 16), "big")
    if len(nonce) != 12:
        raise ValueError("Il nonce GCM deve essere di 12 byte")
    counter = nonce + b"\x00\x00\x00\x01"
    ciphertext = bytearray()
    counter_value = 2  # J0 usa il contatore 1, il primo blocco di dati il 2
    for index in range(0, len(plaintext), 16):
        stream = _aes_block(words, nonce + (counter_value % (1 << 32)).to_bytes(4, "big"))
        chunk = plaintext[index:index + 16]
        ciphertext.extend(a ^ b for a, b in zip(chunk, stream))
        counter_value += 1
    tag = bytes(a ^ b for a, b in zip(
        _ghash(hash_key, aad, bytes(ciphertext)), _aes_block(words, counter)))
    return bytes(ciphertext), tag


# --------------------------------------------------------------------------
# HKDF-SHA256
# --------------------------------------------------------------------------


def hkdf(salt, ikm, info, length):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    output = b""
    block = b""
    counter = 1
    while len(output) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        output += block
        counter += 1
    return output[:length]


# --------------------------------------------------------------------------
# Curva P-256
# --------------------------------------------------------------------------

_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_A = _P - 3
_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)


def _point_add(first, second):
    if first is None:
        return second
    if second is None:
        return first
    x1, y1 = first
    x2, y2 = second
    if x1 == x2 and (y1 + y2) % _P == 0:
        return None
    if first == second:
        slope = (3 * x1 * x1 + _A) * pow(2 * y1, _P - 2, _P) % _P
    else:
        slope = (y2 - y1) * pow(x2 - x1, _P - 2, _P) % _P
    x3 = (slope * slope - x1 - x2) % _P
    y3 = (slope * (x1 - x3) - y1) % _P
    return (x3, y3)


def _point_mul(scalar, point):
    result = None
    addend = point
    while scalar:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        scalar >>= 1
    return result


def _encode_point(point):
    return b"\x04" + point[0].to_bytes(32, "big") + point[1].to_bytes(32, "big")


def _decode_point(data):
    """Accetta un punto P-256 non compresso (0x04) o compresso (0x02/0x03)."""
    if isinstance(data, (tuple, list)) and len(data) == 2:
        x, y = int(data[0]), int(data[1])
        if not (0 <= x < _P and 0 <= y < _P):
            raise ValueError("Chiave pubblica non valida")
        if (y * y - (pow(x, 3, _P) + _A * x + _B)) % _P != 0:
            raise ValueError("Chiave pubblica non valida")
        return (x, y)
    raw = bytes(data)
    if len(raw) == 65 and raw[0] == 0x04:
        x = int.from_bytes(raw[1:33], "big")
        y = int.from_bytes(raw[33:], "big")
    elif len(raw) == 33 and raw[0] in (0x02, 0x03):
        x = int.from_bytes(raw[1:], "big")
        if x >= _P:
            raise ValueError("Chiave pubblica non valida")
        rhs = (pow(x, 3, _P) + _A * x + _B) % _P
        y = pow(rhs, (_P + 1) // 4, _P)
        if (y & 1) != (raw[0] & 1):
            y = _P - y
    else:
        raise ValueError("Chiave pubblica non valida")
    if not (0 <= x < _P and 0 <= y < _P):
        raise ValueError("Chiave pubblica non valida")
    if (y * y - (pow(x, 3, _P) + _A * x + _B)) % _P != 0:
        raise ValueError("Chiave pubblica non valida")
    return (x, y)


def subscription_keys(p256dh, auth):
    """Valida le chiavi di una sottoscrizione e le restituisce in base64url."""
    point = _decode_point(b64url_decode(p256dh))
    secret = b64url_decode(auth or "")
    if len(secret) < 16:
        raise ValueError("Segreto di autenticazione non valido")
    return b64url_encode(_encode_point(point)), b64url_encode(secret[:16])


def generate_private():
    return secrets.randbelow(_N - 1) + 1


def public_from_private(private):
    return _encode_point(_point_mul(private, _G))


def ecdh_secret(private, public_point):
    point = _decode_point(public_point)
    shared = _point_mul(private, point)
    if shared is None:
        raise ValueError("Scambio di chiavi non valido")
    return shared[0].to_bytes(32, "big")


def ecdsa_sign(private, message):
    digest = hashlib.sha256(message).digest()
    z = int.from_bytes(digest, "big")
    while True:
        nonce = secrets.randbelow(_N - 1) + 1
        point = _point_mul(nonce, _G)
        r = point[0] % _N
        if r == 0:
            continue
        s = (pow(nonce, _N - 2, _N) * (z + r * private)) % _N
        if s == 0:
            continue
        if s > _N // 2:  # firma "low-S", accettata da tutti i push service
            s = _N - s
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def ecdsa_verify(public, message, signature):
    try:
        point = _decode_point(public)
        r = int.from_bytes(signature[:32], "big")
        s = int.from_bytes(signature[32:], "big")
        if not (0 < r < _N and 0 < s < _N):
            return False
        z = int.from_bytes(hashlib.sha256(message).digest(), "big")
        w = pow(s, _N - 2, _N)
        u1 = z * w % _N
        u2 = r * w % _N
        result = _point_add(_point_mul(u1, _G), _point_mul(u2, point))
        return bool(result) and result[0] % _N == r
    except (ValueError, IndexError):
        return False


# --------------------------------------------------------------------------
# Cifratura del messaggio (RFC 8291)
# --------------------------------------------------------------------------

RECORD_SIZE = 4096


def encrypt(plaintext, ua_public, auth_secret, salt=None, sender_private=None):
    """Cifra un payload per una sottoscrizione push.

    `ua_public` è la chiave p256dh (base64url), `auth_secret` il segreto auth
    (base64url). `salt` e `sender_private` servono solo per i vettori di test.
    """
    ua_key = _decode_point(b64url_decode(ua_public))
    auth = b64url_decode(auth_secret)
    if len(auth) < 16:
        raise ValueError("Il segreto di autenticazione non è valido")
    private = sender_private if sender_private is not None else generate_private()
    sender_public = public_from_private(private)
    shared = ecdh_secret(private, ua_key)
    ikm = hkdf(auth, shared, b"WebPush: info\x00" + _encode_point(ua_key) + sender_public, 32)
    salt = salt if salt is not None else secrets.token_bytes(16)
    key = hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    ciphertext, tag = aes_gcm_encrypt(key, nonce, bytes(plaintext) + b"\x02")
    header = salt + RECORD_SIZE.to_bytes(4, "big") + bytes([len(sender_public)]) + sender_public
    return header + ciphertext + tag


# --------------------------------------------------------------------------
# VAPID (RFC 8292)
# --------------------------------------------------------------------------


def new_vapid(subject):
    private = generate_private()
    return {
        "private": b64url_encode(private.to_bytes(32, "big")),
        "public": b64url_encode(public_from_private(private)),
        "subject": subject,
    }


def load_vapid(data):
    private = int.from_bytes(b64url_decode(data["private"]), "big")
    if not 0 < private < _N:
        raise ValueError("Chiave VAPID non valida")
    return {
        "private": data["private"],
        "public": data["public"] if data.get("public") else b64url_encode(public_from_private(private)),
        "subject": data.get("subject") or "mailto:ferie@example.com",
    }


def vapid_token(vapid, endpoint, lifetime=12 * 3600):
    parsed = urlsplit(endpoint)
    audience = "%s://%s" % (parsed.scheme, parsed.netloc)
    header = b64url_encode(json.dumps({"typ": "JWT", "alg": "ES256"},
                                      separators=(",", ":")).encode())
    claims = b64url_encode(json.dumps({
        "aud": audience,
        "exp": int(time.time()) + lifetime,
        "sub": vapid["subject"],
    }, separators=(",", ":")).encode())
    signing_input = ("%s.%s" % (header, claims)).encode("ascii")
    private = int.from_bytes(b64url_decode(vapid["private"]), "big")
    signature = ecdsa_sign(private, signing_input)
    return "%s.%s.%s" % (header, claims, b64url_encode(signature))


# --------------------------------------------------------------------------
# Invio
# --------------------------------------------------------------------------


class PushError(Exception):
    def __init__(self, status, message, gone=False):
        Exception.__init__(self, message)
        self.status = status
        self.gone = gone


def send(subscription, payload, vapid, ttl=86400, timeout=10, opener=None):
    """Invia un payload JSON alla sottoscrizione; solleva PushError se fallisce."""
    endpoint = subscription.get("endpoint") or ""
    if not endpoint.startswith("https://"):
        raise PushError(0, "Endpoint push non valido")
    body = encrypt(json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   subscription.get("p256dh") or "", subscription.get("auth") or "")
    request = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "TTL": str(int(ttl)),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Urgency": payload.get("urgency", "high"),
        "Authorization": "vapid t=%s,k=%s" % (vapid_token(vapid, endpoint), vapid["public"]),
    })
    send_open = opener.open if opener else urllib.request.urlopen
    try:
        with send_open(request, timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        gone = exc.code in (404, 410)
        raise PushError(exc.code, "Il servizio push ha risposto %d" % exc.code, gone=gone)
    except urllib.error.URLError as exc:
        raise PushError(0, "Servizio push non raggiungibile: %s" % exc.reason)
    except OSError as exc:
        raise PushError(0, "Invio push non riuscito: %s" % exc)
