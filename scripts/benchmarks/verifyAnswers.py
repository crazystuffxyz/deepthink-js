# scripts/benchmarks/verifyAnswers.py
# Scan each 2024 USAMO solution page for the stated answer/characterization.
# Just surfaces candidate answer phrases so I can sanity-check the gold
# keys against what AoPS community solutions conclude.
import re, html, os

def clean(seg):
    s = re.sub(r'<img[^>]*?alt="(\$[^"]*\$)"[^>]*>', r' \1 ', seg)
    s = re.sub(r'<script.*?</script>', '', s, flags=re.S)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = re.sub(r'[ \t]+', ' ', s)
    return s

for p in range(1, 7):
    f = f"benchmarks/fresh2026/usamo_p{p}.html"
    raw = open(f, encoding="utf-8", errors="ignore").read()
    txt = clean(raw)
    print(f"===== P{p} =====")
    # show lines around 'Answer' or 'are exactly' / 'exactly when' / 'iff'
    hits = []
    for m in re.finditer(r'(answer|Answer|exactly (when|those)|iff|if and only|is (the set|that)|all (pairs|such)|proper divisor|divides)', txt):
        a, b = max(0, m.start() - 80), m.end() + 120
        hits.append(txt[a:b].strip())
    # dedupe, keep first ~6
    seen = set()
    for h in hits:
        if h not in seen:
            seen.add(h)
            print("  ...", h)
            if len(seen) > 6:
                break
    print()
