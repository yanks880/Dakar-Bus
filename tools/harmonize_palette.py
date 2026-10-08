#!/usr/bin/env python3
"""One-shot helper: harmonise the CSS palette around the signature green #198754.

The rewrite keeps the *lightness* of every colour so contrast ratios (text on
background, focus rings, borders) stay untouched, and only moves hue/saturation
for the green family (hue 95-195).  Amber / blue / purple / red identity colours
(network badges, warning states, destination markers) are left alone.
"""
from __future__ import annotations

import colorsys
import re
import sys
from pathlib import Path

SIGNATURE = '#198754'
SIGNATURE_HUE, SIGNATURE_LIGHT, SIGNATURE_SAT = 152.2, 31.4, 68.8

# Teal identity of the "Tata" network must stay distinguishable from the brand green.
KEEP_AS_IS = {'#eef3f2', '#597772'}

HEX_RE = re.compile(r'#[0-9a-fA-F]{6}\b')


def to_hls(value: str) -> tuple[float, float, float]:
    r, g, b = (int(value[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return h * 360, l * 100, s * 100


def to_hex(hue: float, light: float, sat: float) -> str:
    r, g, b = colorsys.hls_to_rgb(hue / 360, light / 100, sat / 100)
    return '#%02x%02x%02x' % (round(r * 255), round(g * 255), round(b * 255))


def target_saturation(light: float, sat: float) -> float:
    if light >= 88:              # surfaces and tints
        return min(42.0, sat * 1.55)
    if light >= 78:              # soft borders, icon chips
        return min(46.0, sat * 1.50)
    if light >= 60:              # muted copy on light surfaces
        return min(30.0, sat * 1.50)
    if light >= 40:              # mid tones, dots, secondary icons
        return min(18.0, sat * 1.90) if sat < 15 else min(46.0, sat * 1.25)
    if sat >= 45:                # accent zone: the signature saturation
        return SIGNATURE_SAT
    return min(52.0, sat * 1.08)  # deep greens used for headings and text


def harmonise(value: str) -> str:
    raw = value.lower()
    if raw in KEEP_AS_IS:
        return raw
    hue, light, sat = to_hls(raw)
    if sat < 3:                  # pure greys, white, black
        return raw
    if not 95 <= hue <= 195:     # ambers, blues, purples, reds: identity colours
        return raw
    if light >= 99 and sat < 12:  # near-white: handled by the tint pass
        return raw
    if 28 <= light <= 34 and sat >= 45:
        return SIGNATURE          # the accent band collapses onto the signature green
    return to_hex(SIGNATURE_HUE, light, target_saturation(light, sat))


def rewrite(path: Path, apply: bool) -> int:
    text = path.read_text(encoding='utf-8')
    seen: dict[str, str] = {}

    def replace(match: re.Match[str]) -> str:
        original = match.group(0)
        if original.lower() not in seen:
            seen[original.lower()] = harmonise(original)
        return seen[original.lower()]

    updated = HEX_RE.sub(replace, text)
    changed = sum(1 for old, new in seen.items() if old != new)
    if apply:
        path.write_text(updated, encoding='utf-8')
    print(f'{path}: {len(seen)} colours, {changed} rewritten')
    return changed


def main() -> None:
    apply = '--apply' in sys.argv
    targets = [Path(arg) for arg in sys.argv[1:] if not arg.startswith('--')]
    for target in targets:
        rewrite(target, apply)
    if not apply:
        print('\n(dry run — pass --apply to write)')


if __name__ == '__main__':
    main()
