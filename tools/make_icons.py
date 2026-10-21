#!/usr/bin/env python3
"""Genera le icone PNG dell'app senza librerie esterne.

    python3 tools/make_icons.py
"""

import math
import struct
import zlib
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent / "public"
SCALE = 4
SIZES = {"icon-512.png": 512, "icon-192.png": 192, "apple-touch-icon.png": 180}

GREEN = (0, 95, 150)
DARK = (0, 56, 103)
PAPER = (255, 253, 249)


def sdf_round_rect(x, y, x0, y0, x1, y1, radius):
    cx = min(max(x, x0 + radius), x1 - radius)
    cy = min(max(y, y0 + radius), y1 - radius)
    return math.hypot(x - cx, y - cy) - radius


def sdf_segment(x, y, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = x - ax, y - ay
    length = vx * vx + vy * vy
    t = 0.0 if length == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / length))
    return math.hypot(wx - t * vx, wy - t * vy)


def render(size):
    hi = size * SCALE
    unit = hi / 512.0
    pixels = bytearray(hi * hi * 3)

    page = (112 * unit, 132 * unit, 400 * unit, 404 * unit, 40 * unit)
    header = (112 * unit, 132 * unit, 400 * unit, 212 * unit)
    check = [
        (188 * unit, 292 * unit, 246 * unit, 348 * unit),
        (246 * unit, 348 * unit, 330 * unit, 244 * unit),
    ]
    hangers = [(168 * unit, 96 * unit, 192 * unit, 172 * unit),
               (320 * unit, 96 * unit, 344 * unit, 172 * unit)]

    for py in range(hi):
        y = py + 0.5
        for px in range(hi):
            x = px + 0.5
            # sfondo: quadrato arrotondato verde
            if sdf_round_rect(x, y, 0, 0, hi, hi, 112 * unit) <= 0:
                color = GREEN
            else:
                color = (244, 241, 234)
            if sdf_round_rect(x, y, *page) <= 0:
                color = PAPER
            if header[0] <= x <= header[2] and header[1] <= y <= header[3] and sdf_round_rect(x, y, *page) <= 0:
                color = DARK
            for ax, ay, bx, by in hangers:
                if sdf_segment(x, y, ax, ay, bx, by) <= 12 * unit:
                    color = PAPER
            for ax, ay, bx, by in check:
                if sdf_segment(x, y, ax, ay, bx, by) <= 15 * unit:
                    color = GREEN
            offset = (py * hi + px) * 3
            pixels[offset:offset + 3] = bytes(color)

    # riduzione con media dei blocchi SCALE x SCALE (antialiasing)
    out = bytearray(size * size * 3)
    block = SCALE * SCALE
    for y in range(size):
        for x in range(size):
            r = g = b = 0
            base_y = y * SCALE
            base_x = x * SCALE
            for dy in range(SCALE):
                row = ((base_y + dy) * hi + base_x) * 3
                for dx in range(SCALE):
                    off = row + dx * 3
                    r += pixels[off]
                    g += pixels[off + 1]
                    b += pixels[off + 2]
            off = (y * size + x) * 3
            out[off] = r // block
            out[off + 1] = g // block
            out[off + 2] = b // block
    return out


def write_png(path, size, rgb):
    raw = bytearray()
    stride = size * 3
    for y in range(size):
        raw.append(0)
        raw.extend(rgb[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    path.write_bytes(png)


def main():
    for name, size in SIZES.items():
        write_png(PUBLIC / name, size, render(size))
        print("Scritto", PUBLIC / name)


if __name__ == "__main__":
    main()
