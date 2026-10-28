#!/usr/bin/env python3
"""Generate MacroTally app icons with only the Python stdlib (zlib + struct, no PIL).

Writes icons/icon-192.png, icons/icon-512.png and icons/icon.svg (relative to the project root):
a dark-green (#2e7d5b) rounded square with a faint white ring track, a solid white arc and
a filled amber accent arc, like a macro progress ring. Run from the project root:

    python tools/make_icons.py
"""
import math
import os
import struct
import zlib

BG = (0x2E, 0x7D, 0x5B)
WHITE = (0xFF, 0xFF, 0xFF)
ACCENT = (0xF5, 0xB9, 0x42)

CORNER = 0.22      # corner radius as a fraction of size
RING_R = 0.30      # ring radius
RING_T = 0.085     # ring thickness
TRACK_ALPHA = 0.28
ARCS = [           # (start_deg, end_deg, color), clockwise from 12 o'clock
    (0.0, 235.0, WHITE),
    (252.0, 322.0, ACCENT),
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'icons')


def sd_round_rect(px, py, size, radius):
    """Signed distance to a rounded square covering the full canvas."""
    h = size / 2.0
    qx = abs(px - h) - (h - radius)
    qy = abs(py - h) - (h - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - radius


def angle_cw_from_top(dx, dy):
    a = math.degrees(math.atan2(dx, -dy))
    return a + 360.0 if a < 0 else a


def sd_arc(px, py, c, r, t, a0, a1):
    """Signed distance to a stroked arc with round caps."""
    dx, dy = px - c, py - c
    a = angle_cw_from_top(dx, dy)
    if a0 <= a <= a1:
        return abs(math.hypot(dx, dy) - r) - t / 2.0
    best = float('inf')
    for ang in (a0, a1):
        rad = math.radians(ang)
        ex, ey = c + r * math.sin(rad), c - r * math.cos(rad)
        best = min(best, math.hypot(px - ex, py - ey))
    return best - t / 2.0


def coverage(d):
    return max(0.0, min(1.0, 0.5 - d))


def over(dst, color, alpha):
    """Composite straight-alpha color over dst (r, g, b, a floats 0..1)."""
    if alpha <= 0:
        return dst
    dr, dg, db, da = dst
    sr, sg, sb = (v / 255.0 for v in color)
    oa = alpha + da * (1 - alpha)
    if oa <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    k = da * (1 - alpha)
    return ((sr * alpha + dr * k) / oa, (sg * alpha + dg * k) / oa, (sb * alpha + db * k) / oa, oa)


def render(size):
    c = size / 2.0
    r = RING_R * size
    t = RING_T * size
    corner = CORNER * size
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # filter type: None
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            px_ = (0.0, 0.0, 0.0, 0.0)
            cov = coverage(sd_round_rect(px, py, size, corner))
            if cov > 0:
                px_ = over(px_, BG, cov)
                # Round caps lie inside the ring band, so only pixels near the band need arc tests.
                ring_d = abs(math.hypot(px - c, py - c) - r) - t / 2.0
                if ring_d < 1.0:
                    px_ = over(px_, WHITE, coverage(ring_d) * TRACK_ALPHA * cov)
                    for a0, a1, col in ARCS:
                        px_ = over(px_, col, coverage(sd_arc(px, py, c, r, t, a0, a1)) * cov)
            rows.extend(int(round(v * 255)) for v in px_)
    return bytes(rows)


def chunk(tag, data):
    body = tag + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)


def write_png(path, size):
    raw = render(size)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def hex_color(c):
    return '#%02x%02x%02x' % c


def arc_path(c, r, a0, a1):
    def pt(a):
        rad = math.radians(a)
        return c + r * math.sin(rad), c - r * math.cos(rad)
    x0, y0 = pt(a0)
    x1, y1 = pt(a1)
    large = 1 if (a1 - a0) > 180 else 0
    return 'M%.2f %.2f A%.2f %.2f 0 %d 1 %.2f %.2f' % (x0, y0, r, r, large, x1, y1)


def write_svg(path, size=512):
    c = size / 2.0
    r = RING_R * size
    t = RING_T * size
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d">' % (size, size, size, size),
        '<rect width="%d" height="%d" rx="%.2f" fill="%s"/>' % (size, size, CORNER * size, hex_color(BG)),
        '<circle cx="%.2f" cy="%.2f" r="%.2f" fill="none" stroke="#ffffff" stroke-opacity="%.2f" stroke-width="%.2f"/>'
        % (c, c, r, TRACK_ALPHA, t),
    ]
    for a0, a1, col in ARCS:
        parts.append('<path d="%s" fill="none" stroke="%s" stroke-width="%.2f" stroke-linecap="round"/>'
                     % (arc_path(c, r, a0, a1), hex_color(col), t))
    parts.append('</svg>')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(parts) + '\n')


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (192, 512):
        p = os.path.join(OUT_DIR, 'icon-%d.png' % size)
        write_png(p, size)
        print('wrote', os.path.relpath(p, ROOT))
    p = os.path.join(OUT_DIR, 'icon.svg')
    write_svg(p)
    print('wrote', os.path.relpath(p, ROOT))


if __name__ == '__main__':
    main()
