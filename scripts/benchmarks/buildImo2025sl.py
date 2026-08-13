#!/usr/bin/env python3
# scripts/benchmarks/buildImo2025sl.py
# Parse the official IMO 2025 Shortlist PDF into a clean jsonl dataset.
#
# The PDF ships with a broken ToUnicode CMap: the same glyph slot maps to a
# random ASCII/Latin-1 char. We disambiguate by actual font name, then rebuild
# structure (sub/superscripts, stacked fractions, radicals) from per-char
# geometry: bars from the page's drawings, sub/sup from baseline offsets,
# same-visual-line fragments chained by y-proximity.

import json
import re
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / "benchmarks" / "fresh2026" / "IMO2025SL.pdf"
OUT = ROOT / "benchmarks" / "data" / "imo2025sl.jsonl"
OUT.parent.mkdir(parents=True, exist_ok=True)

# font -> {broken char: real char}. Only the TeX math fonts are mangled;
# prose fonts map cleanly.
FONT_MAP = {
    # size variants of the math-symbol font share one logical mapping
    "TeX-matha6": {
        "`": "+", "“": "=", "´": "−", "1": "1",
    },
    "TeX-matha7": {
        "1": "1",
    },
    "TeX-matha8": {
        "`": "+", "“": "=", "´": "−", "ě": "≥", "ą": ">", "p": "(", "q": ")",
        "?": "√", "Ñ": "→", "¨": "·", "P": "∈", "{": "/", "x": "⟨", "y": "⟩",
        "˝": "°", "˚": "∘", " ": " ",
    },
    "TeX-matha10": {
        "`": "+", "“": "=", "´": "−", "ď": "≤", "ě": "≥", "ă": "<", "ą": ">",
        "‰": "≠", "Ñ": "→", "¨": "·", "p": "(", "q": ")", "t": "{", "u": "}",
        "r": "[", "s": "]", "x": "⟨", "y": "⟩", "P": "∈", "R": "∉", "H": "∅",
        "?": "√", "ù": "⟹", "ñ": "⇒", "”": "≡", "ı": "≡", "Y": "∪", "ˆ": "×",
        "{": "/", "|": "|", " ": " ",
    },
    "TeX-matha12": {
        "`": "+", "“": "=", "´": "−", "¨": "·", "ď": "≤", "ě": "≥", "ă": "<",
        "ą": ">", "‰": "≠", "Ñ": "→", "˝": "°", "˚": "∘", "ÿ": "∑", "ř": "∑",
        "˘": ")", "„": "∼", "ˇ": "|", "Ď": "⊆", "¯": ")", "˜": "(", "¸": ")",
        "ź": "∏", "ś": "∏", "Þ": "↦", "␣": "{", "{": "/", "p": "(", "q": ")",
        "u": "}", "P": "∈", "K": "⊥", "R": "∉", "X": "∩", "Y": "∪", "H": "∅",
        "8": "∞", "?": "√", "@": "∀", "t": "{", "r": "[", "s": "]", "x": "⟨",
        "y": "⟩", "ñ": "⇒", "ô": "⇔", "ù": "⟹", "ı": "≡", "”": "≡", "–": "≅",
        "Ý": "→", "|": "|", "ˆ": "×", " ": " ",
    },
    # bold math: floor/ceiling pieces, angles, black squares
    "TeX-mathb8": {
        "ã": "↪", "r": "⌈", "s": "⌉", " ": " ",
    },
    "TeX-mathb10": {
        "r": "⌈", "s": "⌉", " ": " ",
    },
    "TeX-mathb12": {
        "=": "∠", "t": "⌊", "u": "⌋", "l": "■", "ă": "<", "r": "⌈", "s": "⌉",
        " ": " ",
    },
    # extension font: tall delimiters, sums, products, roots. The 4 tall-paren
    # slot pairs (cmex10 0-7) surface as several broken chars; matched by
    # geometry on pages where they appear (tuple equations, `(2^ℓ−1)` etc.)
    "TeX-mathx10": {
        "Z": "⌊", "^": "⌋", "#": "{", "P": "⌊", "T": "⌋", "R": "⌊", "V": "⌋",
        "`": "(", "˘": ")", "ÿ": "∑", "ř": "∑", "ź": "∏", "ś": "∏", "b": "√",
        "a": "√", "ˇ": "|", "ˆ": "(", "˙": ")", "´": "(", "¯": ")",
        "˜": "(", "¸": ")", "␣": "{", "(": "}", "$": "{", "&": "|",
        "%": "}", "’": "|",
        # ‘+’ is the tall right-brace extension piece (verified: every mathx10
        # ‘+’ in the PDF is 32-36pt tall); l/m/n/o are underbrace pieces — map
        # to their brace extension segment marker (consumed by frac_merge)
        "+": "}", "l": "}", "m": "}", "n": "}", "o": "}", " ": " ",
    },
    # AMS blackboard bold
    "MSBM10": {
        "Z": "ℤ", "C": "ℂ", "Q": "ℚ", "R": "ℝ", "∤": "∤", " ": " ",
    },
    # real symbols that happen to live in a symbol font; keep as-is
    "CMSY10": None,
    # tall parens from CMEX10
    "CMEX10": {
        "\x1c": "(", "\x1d": ")", " ": " ",
    },
}

# fonts whose glyphs decode 1:1
KEEP_FONTS = {
    "SFRM0700", "SFRM0800", "SFRM1000", "SFRM1095", "SFRM1200",
    "SFTI1095", "SFTI1200", "SFBX1095", "SFBX1200", "SFBX1728", "SFBX2074", "SFBX2488",
    "SFTT1095",
    "Gotham-Book", "Gotham-Bold", "Gotham-Medium",
    "NimbusSanL-Regu", "NimbusSanL-Bold",
    "CMMI6", "CMMI7", "CMMI8", "CMMI10", "CMMI12",
    "CMR6", "CMR7", "CMR8", "CMR10", "CMR12",
}

SUP = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵",
    "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "f": "ᶠ", "g": "ᵍ",
    "h": "ʰ", "i": "ⁱ", "j": "ʲ", "k": "ᵏ", "l": "ˡ", "m": "ᵐ", "n": "ⁿ",
    "o": "ᵒ", "p": "ᵖ", "r": "ʳ", "s": "ˢ", "t": "ᵗ", "u": "ᵘ", "v": "ᵛ",
    "w": "ʷ", "x": "ˣ", "y": "ʸ", "z": "ᶻ",
    "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "α": "ᵅ", "β": "ᵝ", "γ": "ᵞ", "δ": "ᵟ", "ε": "ᵋ", "θ": "ᶿ",
    "λ": "ᶺ", "μ": "ᵘ", "ν": "ᵛ", "π": "ᵖ", "ρ": "ᵖ", "σ": "ˢ", "φ": "ᵠ",
    "ω": "ᵒ", "ℓ": "ˡ", "°": "°",
    # nu (ν) and script l (ℓ) explicit entries — the Greek ν maps to ᵛ above,
    # but the Latin-letter nu variant needs its own slot; same for ℓ
}
SUB = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅",
    "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "l": "ₗ",
    "m": "ₘ", "n": "ₙ", "o": "ₒ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ",
    "u": "ᵤ", "v": "ᵥ", "x": "ₓ",
    "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
    "α": "ₐ", "β": "ᵦ", "γ": "ᵧ", "ρ": "ᵨ", "φ": "ᵩ", "χ": "ᵪ",
    "ν": "ᵥ", "ℓ": "ₗ",
}


def dec(c):
    """decode one char with its font"""
    font = c["font"]
    if font in KEEP_FONTS:
        return c["ch"]
    table = FONT_MAP.get(font)
    if table is None:
        return c["ch"]
    return table.get(c["ch"], c["ch"])


def is_sym(font):
    # operator/symbol fonts whose glyphs sit lower than the text baseline
    return font.startswith(("TeX-matha", "TeX-mathb", "TeX-mathx", "CMEX"))


def is_ext(font):
    # tall-delimiter font (⌊⌋⌈⌉∑∏ tall parens, √); chars span the whole line
    return font == "TeX-mathx10" or font == "CMEX10"


def is_math_font(font):
    # prose fonts are the only non-math ones here
    return not font.startswith(("SFRM", "SFTI", "SFBX", "SFTT", "Gotham", "Nimbus"))


def is_root(c):
    return not c.get("seg") and dec(c) == "√"


def page_chars(doc, pno):
    """rawdict lines as lists of char dicts"""
    raw = doc[pno].get_text("rawdict")
    lines = []
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            chars = []
            for span in line.get("spans", []):
                font = span["font"]
                size = span["size"]
                for c in span.get("chars", []):
                    x0, y0, x1, y1 = c["bbox"]
                    chars.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1,
                                  "yc": (y0 + y1) / 2, "ch": c["c"],
                                  "font": font, "size": size, "used": False})
            chars.sort(key=lambda c: c["x0"])
            if chars:
                lines.append(chars)
    return lines


def page_bars(doc, pno):
    """horizontal rules: fraction bars and radical overlines"""
    bars = []
    for d in doc[pno].get_drawings():
        for item in d["items"]:
            if item[0] != "l":
                continue
            p1, p2 = item[1], item[2]
            if abs(p1.y - p2.y) >= 0.5:
                continue
            x0, x1 = min(p1.x, p2.x), max(p1.x, p2.x)
            if x0 > 100 and 3 <= x1 - x0 <= 200:
                bars.append({"y": (p1.y + p2.y) / 2, "y0": (p1.y + p2.y) / 2 - 0.25,
                             "y1": (p1.y + p2.y) / 2 + 0.25, "x0": x0, "x1": x1,
                             "used": False})
    return bars


def xlap(c, bar):
    return c["x0"] < bar["x1"] - 0.5 and c["x1"] > bar["x0"] + 0.5


def frac_merge(chars, bars):
    """merge stacked fractions: num 2-10pt above the bar, den 2-14pt below,
    both x-overlapping it. Bars that anchor a √ (radical overlines) are left
    for rad_merge."""
    for bar in bars:
        anchored = any(not c["used"] and is_root(c)
                       and abs(bar["x0"] - c["x1"]) < 2
                       and bar["y"] > c["y0"] and bar["y"] < c["y1"]
                       for c in chars)
        if anchored:
            continue
        num, den = [], []
        for c in chars:
            if c["used"] or not xlap(c, bar):
                continue
            # math fonts only: prose descenders above/below a display
            # equation sit in the same y bands as real nums/dens
            if not is_math_font(c["font"]):
                continue
            # small matha glyphs sit ~3pt low in their bbox, so their bands
            # shift down; full-size chars can't be sups/subs, so they get a
            # tight band (a char a full line above the bar is not part of the
            # fraction)
            if c["size"] > 8.5:
                num_lo, num_hi = bar["y"] - 10, bar["y"] - 2
                den_lo, den_hi = bar["y"] + 2, bar["y"] + 10
            else:
                shift = 3 if c["font"].startswith("TeX-matha") else 0
                num_lo, num_hi = bar["y"] - 14 + shift, bar["y"] - 2 + shift
                den_lo, den_hi = bar["y"] + 2 + shift, bar["y"] + 16 + shift
            if num_lo < c["yc"] < num_hi:
                if is_ext(c["font"]) and not is_root(c):
                    continue
                num.append(c)
            elif den_lo < c["yc"] < den_hi:
                if is_ext(c["font"]) and not is_root(c):
                    continue
                den.append(c)
        if not num or not den:
            continue
        num.sort(key=lambda c: c["x0"])
        den.sort(key=lambda c: c["x0"])
        # render() derives the baseline from the chars themselves, so subs
        # and sups inside num/den (⟨x⟩₁, 2², 2ᵏ⁻¹) come out right
        ntxt = render(num).strip()
        dtxt = render(den).strip()
        for c in num + den:
            c["used"] = True
        seg = {"x0": min(c["x0"] for c in num) - 2, "x1": max(c["x1"] for c in den) + 2,
               "y0": min(c["y0"] for c in num), "y1": max(c["y1"] for c in den),
               "yc": bar["y"], "ch": f"({ntxt})/({dtxt})", "font": "",
               "size": 12, "used": True, "seg": True}
        bar["used"] = True
        chars.append(seg)


def median(vals):
    vals = sorted(vals)
    return vals[len(vals) // 2]


def fb(t, sup):
    """fallback for a sub/sup char missing from the tables: letters and
    structural chars keep the ^{t}/_{t} marker (I_B, t^{/} legit); symbols
    (≥, >, ∈, ·, :, ↪, →, ∗) render plain — symbols don't need sub/sup
    markers since they're operators, not variables"""
    # letters (ASCII and Greek) and delimiters get ^{t}/_{t}
    if t.isalpha() or t in ("/", "⟨", "⟩", "⌈", "⌉"):
        return f"^{{{t}}}" if sup else f"_{{{t}}}"
    # symbols render plain (no marker)
    return t


def render(chars, base=None):
    """render chars with sub/sup detection against a baseline; pass base to
    use a caller-computed one, else compute from the chars themselves"""
    if base is None:
        vals = [c["yc"] for c in chars if c["size"] >= 10 and not is_sym(c["font"])]
        base = median(vals) if vals else None
    out = []
    # bucket x0 into 2pt cells so appended ∑-limits stay after their ∑ glyph
    # (their x0s interleave with the ∑); limits sort sub-before-sup
    def skey(c):
        lim = c.get("lim")
        if lim is not None and base is not None:
            return (lim["x0"] // 2 + 0.5, 0 if c["yc"] > base else 1, c["x0"])
        return (c["x0"] // 2, 0, 0)
    for c in sorted(chars, key=skey):
        if c.get("seg"):
            out.append(c["ch"])
            continue
        if c.get("used"):
            continue
        t = dec(c)
        if base is not None and c["size"] <= 8.5:
            if c["font"].startswith("TeX-matha") and not c.get("ycf"):
                # unshifted small variants sit ~3pt low in their box: sup
                # band starts below base+1, sub band above base+5
                if c["yc"] < base + 1:
                    out.append(SUP.get(t, fb(t, True)) if t.strip() else " ")
                elif c["yc"] > base + 5:
                    out.append(SUB.get(t, fb(t, False)) if t.strip() else " ")
                else:
                    out.append(t)
            elif c["yc"] < base - 1.5:
                out.append(SUP.get(t, fb(t, True)) if t.strip() else " ")
            elif c["yc"] > base + 1.5:
                out.append(SUB.get(t, fb(t, False)) if t.strip() else " ")
            else:
                out.append(t)
        else:
            out.append(t)
    return "".join(out)


def rad_merge(chars, bars):
    """merge √ with its radicand. Anchor: an overline bar touching the √'s
    top-right corner. Radicand: math chars hanging under the bar. If the bar
    also carried a fraction segment, that wins (√((1)/(2)))."""
    for r in [c for c in chars if not c["used"] and is_root(c)]:
        bar = next((b for b in bars if not b["used"]
                    and abs(b["x0"] - r["x1"]) < 2
                    and b["y"] > r["y0"] and b["y"] < r["y1"]), None)
        if bar is not None:
            content = [c for c in chars if not c["used"] and not c.get("seg")
                       and is_math_font(c["font"])
                       and c["x0"] >= bar["x0"] - 2 and c["x1"] <= bar["x1"] + 2
                       and c["y0"] >= bar["y"] - 1 and c["y1"] < bar["y"] + 40]
            fracs = [c for c in chars if c.get("seg") and not c["ch"].startswith("√(")
                     and abs(c["yc"] - bar["y"]) < 8 and xlap(c, bar)]
            inner = fracs[0]["ch"] if fracs else render(content)
            for c in content:
                c["used"] = True
            seg = {"x0": r["x0"], "x1": bar["x1"], "y0": r["y0"], "y1": bar["y1"],
                   "yc": r["yc"], "ch": f"√({inner})", "font": "",
                   "size": 12, "used": True, "seg": True}
            r["used"] = True
            bar["used"] = True
            chars.append(seg)
            continue
        # bar-less √: hug the run of math chars right of it (e.g. √2)
        run = [c for c in chars if not c["used"] and not c.get("seg")
               and is_math_font(c["font"])
               and abs(c["x0"] - r["x1"]) < 4 and c["x1"] < r["x1"] + 25
               and c["y0"] < r["y1"] and c["y1"] > r["y0"]]
        if run:
            for c in run:
                c["used"] = True
            seg = {"x0": r["x0"], "x1": max(c["x1"] for c in run), "y0": r["y0"],
                   "y1": r["y1"], "yc": r["yc"], "ch": f"√({render(run)})",
                   "font": "", "size": 12, "used": True, "seg": True}
            r["used"] = True
            chars.append(seg)


def line_has_math_bigs(ln):
    """line carries real math content (non-delimiter font at text size);
    used chars (consumed by frac/rad merges) and spaces don't count"""
    return any(c["size"] >= 10 and c["font"] not in ("TeX-mathx10", "CMEX10")
               and is_math_font(c["font"]) and dec(c).strip()
               for c in ln if not c.get("used"))


def is_sum_fragment(ln):
    """a ∑-fragment: every non-small char is a ∑/∏ glyph or x-adjacent to one
    (a size-12 coefficient '2' glued to the first ∑ still counts)"""
    sums = [c for c in ln if c["font"] == "TeX-mathx10" and dec(c) in ("∑", "∏")]
    if not sums:
        return False
    for c in ln:
        if c.get("used") or c.get("seg") or c.get("lim"):
            continue
        if c["size"] <= 8.5:
            continue
        if c in sums:
            continue
        if not any(c["x0"] < s["x1"] + 20 and c["x1"] > s["x0"] - 20 for s in sums):
            return False
    return True


def orphan_small_merge(lines):
    """merge small-only orphan lines (all unused chars ≤ 8.5pt, no segs, no
    ∑/∏) into the nearest math-big line within 14pt — catches sup/sub chars
    chain_lines stranded (e.g. the tⁱ sup-i's x-far from their ∑)"""
    for ln in list(lines):
        if not ln:
            continue
        if any(c.get("seg") or (c["font"] == "TeX-mathx10"
                                and dec(c) in ("∑", "∏"))
               for c in ln if not c.get("used")):
            continue
        if any(c["size"] >= 10 and dec(c).strip()
               for c in ln if not c.get("used")):
            continue
        if not any(not c.get("used") for c in ln):
            continue
        fy = median([c["yc"] for c in ln if not c.get("used")])
        cands = [l for l in lines if l is not ln and line_has_math_bigs(l)
                 and abs(line_yc(l) - fy) < 14
                 and any(c["x0"] < h["x1"] + 14 and c["x1"] > h["x0"] - 14
                         for c in ln if not c.get("used")
                         for h in l if not h.get("used"))]
        if not cands:
            continue
        host = min(cands, key=lambda l: abs(line_yc(l) - fy))
        for c in ln:
            host.append(c)
        lines.remove(ln)


def sum_merge(lines):
    """attach tall ∑/∏ glyphs and their limit fragments (ᵢ₌₁, ᵏ) to the host
    display line. Tall delimiters span several baselines so chain_lines leaves
    their limits (sup k, sub i=1) in separate small-only fragments."""
    # 1) mark limits already sitting in the ∑'s own line (they chained), then
    #    pull x-near smalls from small-only lines onto their ∑'s line
    for ln in list(lines):
        for s in [c for c in ln if c["font"] == "TeX-mathx10"
                  and dec(c) in ("∑", "∏")]:
            for c in ln:
                if not c.get("used") and not c.get("lim") and c["size"] <= 8.5 \
                   and c["x0"] < s["x1"] + 14 and c["x1"] > s["x0"] - 14 \
                   and s["y0"] - 11 < c["yc"] < s["y1"] + 5:
                    c["lim"] = s
            for host_ln in list(lines):
                if host_ln is ln or line_has_math_bigs(host_ln):
                    continue
                take = [c for c in host_ln if not c.get("used")
                        and c["size"] <= 8.5
                        and c["x0"] < s["x1"] + 14 and c["x1"] > s["x0"] - 14
                        and s["y0"] - 11 < c["yc"] < s["y1"] + 5]
                for c in take:
                    host_ln.remove(c)
                    c["lim"] = s
                    ln.append(c)
    # 2) merge ∑-fragments (pure, or with x-adjacent bigs like a '2' coeff)
    #    into the nearest math line within 14pt
    for ln in list(lines):
        if not is_sum_fragment(ln):
            continue
        fy = median([c["yc"] for c in ln if c["font"] == "TeX-mathx10"])
        cands = [l for l in lines if l is not ln and line_has_math_bigs(l)
                 and abs(line_yc(l) - fy) < 14]
        if not cands:
            continue
        host = min(cands, key=lambda l: abs(line_yc(l) - fy))
        for c in ln:
            host.append(c)
        lines.remove(ln)


def line_yc(ln):
    # segs (synthetic fractions/radicals) carry the bar's y, which IS the
    # visual line's baseline, so let them anchor the line position
    vals = [c["yc"] for c in ln if c["size"] >= 10 and not is_sym(c["font"])]
    if not vals:
        vals = [c["yc"] for c in ln]
    return median(vals) if vals else 0


def chain_lines(lines):
    """chain rawdict lines whose baselines are within 6.5pt into one visual
    line (fraction/radical fragments hang off their host line)"""
    lines = sorted(lines, key=line_yc)
    if not lines:
        return []
    out = []
    cur = lines[0]
    for ln in lines[1:]:
        if abs(line_yc(ln) - line_yc(cur)) <= 6.5:
            cur = cur + ln
        else:
            out.append(cur)
            cur = ln
    out.append(cur)
    return out


def fix_sym_yc(lines):
    """sym-font glyphs (matha/mathb/mathx/CMEX) have bbox centers off their
    baseline — tall delimiters by ~18pt, matha12 symbols by ~4.6pt — so
    chain_lines would glue them to the wrong line. Give every size>=10 sym
    char the median baseline of size>=10 non-sym chars x-near it (a fraction
    numerator's +/( must take the numerator's baseline, not the line's);
    small variants (matha8 etc.) keep their true sub/sup position."""
    anchors = [c for ln in lines for c in ln
               if c["size"] >= 10 and not is_sym(c["font"])]
    for ln in lines:
        for c in ln:
            if c["size"] >= 10 and is_sym(c["font"]):
                # tall glyphs' bbox centers sit ~18pt off their baseline,
                # matha12 symbols ~4.6pt — y-window per glyph class
                win = 20 if is_ext(c["font"]) else 8
                near = [a["yc"] for a in anchors
                        if a["x0"] < c["x1"] + 15 and a["x1"] > c["x0"] - 15
                        and abs(a["yc"] - c["yc"]) < win]
                if near:
                    c["yc"] = median(near)
                    c["ycf"] = True


def decode_page(doc, pno):
    lines = page_chars(doc, pno)
    bars = page_bars(doc, pno)
    fix_sym_yc(lines)
    chars = [c for ln in lines for c in ln]
    frac_merge(chars, bars)
    rad_merge(chars, bars)
    lns = chain_lines([[c] for c in chars])
    sum_merge(lns)
    orphan_small_merge(lns)
    parts = []
    for ln in lns:
        text = render(ln)
        text = re.sub(r"[ \t]{2,}", " ", text).strip()
        if text:
            parts.append(text)
    return "\n".join(parts)


def extract_text_pages(doc, start, end):
    return "\n\n".join(decode_page(doc, pno) for pno in range(start, end))


def split_by_headings(text):
    """split into chunks by problem headings A1., A2., ..., N8."""
    pattern = re.compile(r"\n\s*([ACGN])(\d+)\.\s*\n", re.MULTILINE)
    matches = list(pattern.finditer(text))
    chunks = []
    for i, m in enumerate(matches):
        cat, num = m.group(1), m.group(2)
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunks.append({
            "id": f"imo2025sl-{cat}{num}",
            "category": cat,
            "number": int(num),
            "text": text[start:end].strip(),
        })
    return chunks


def post_process_text(text):
    """final cleanup: ligatures, ellipsis, product dots, leftover stacked
    floor/ceiling fractions, whitespace"""
    text = text.replace("ﬁ", "fi").replace("ﬂ", "fl").replace("ﬃ", "ffi").replace("ﬀ", "ff")
    text = text.replace("‌", "")
    # \cdots renders as three product dots; collapse to a plain ellipsis
    text = re.sub(r"·\s*·\s*·", "...", text)
    text = re.sub(r"\.\s*\.\s*\.", "...", text)
    text = text.replace("ˆ", "×")
    # floor/ceil stacked fractions with no drawn bar (rare)
    text = re.sub(
        r"⌊\n\s*([^\n]+?)\n\s*([0-9]+)\n\s*⌋",
        lambda m: f"⌊({m.group(1).strip()})/({m.group(2).strip()})⌋",
        text, flags=re.DOTALL)
    text = re.sub(
        r"⌈\n\s*([^\n]+?)\n\s*([0-9]+)\n\s*⌉",
        lambda m: f"⌈({m.group(1).strip()})/({m.group(2).strip()})⌉",
        text, flags=re.DOTALL)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_headers(text):
    """page header/footer banners. Page numbers may sit on their own line or
    chain onto the banner (same visual line), so tolerate digits in both
    spots; digit-only math lines are never touched since the digits must be
    glued to banner text."""
    text = re.sub(r"^\d*\s*Sunshine Coast[^\n]*\n?", "", text)
    text = re.sub(r"\n\d*\s*Sunshine Coast[^\n]*\n?", "\n", text)
    text = re.sub(r"\nShortlisted problems[^\n]*(?:\n\d+)?\n", "\n", text)
    text = re.sub(r"^\s*Shortlisted problems[^\n]*(?:\n\d+)?\n", "", text)
    text = re.sub(r"\n?\s*Shortlisted problems[^\n]*\d*\s*$", "", text)
    text = re.sub(r"^\s*(?:Algebra|Combinatorics|Geometry|Number Theory|Solutions)\s*$",
                  "", text, flags=re.MULTILINE)
    # standalone country attribution lines, e.g. "(China)"
    text = re.sub(r"^\s*\([A-Z][a-z]+\)\s*$", "", text, flags=re.MULTILINE)
    return text


def clean_problem(text):
    text = strip_headers(text)
    text = post_process_text(text)
    # trailing country attribution, e.g. "(China)"
    lines = text.splitlines()
    while lines and re.match(r"^\s*\([^)]{2,120}\)\s*$", lines[-1]):
        lines.pop()
    return "\n".join(lines).strip()


def clean_solution(text):
    return post_process_text(strip_headers(text))


def main():
    if not PDF.exists():
        print(f"Missing PDF: {PDF}", file=sys.stderr)
        sys.exit(1)

    doc = pymupdf.open(PDF)
    # problems: p4-p11 (0-indexed 3-10); solutions: p12 to end (0-indexed 11+)
    problems_text = extract_text_pages(doc, 3, 11)
    solutions_text = extract_text_pages(doc, 11, len(doc))

    problems = split_by_headings(problems_text)
    solutions = split_by_headings(solutions_text)

    prob_map = {p["id"]: p for p in problems}

    with OUT.open("w", encoding="utf-8") as f:
        for s in solutions:
            pid = s["id"]
            prob = prob_map.get(pid)
            if prob is None:
                print(f"Warning: no problem for {pid}", file=sys.stderr)
                continue
            record = {
                "id": pid,
                "source": "imo-2025-shortlist",
                "kind": "math-proof",
                "problem": clean_problem(prob["text"]),
                "answer": clean_solution(s["text"]),
            }
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
