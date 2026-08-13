# scripts/benchmarks/extractUsamo.py
# Pull the real USAMO problems + official answer claims off the AoPS wiki
# pages and rebuild benchmarks/data/usamo-2024.jsonl. AoPS only carries
# community "Solution" threads per problem, so the gold answer is the
# problem's asked-for object / known official result, entered manually
# from the contest record.
import re, html, json, os, urllib.request

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
}

def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "ignore")

def clean(html_seg):
    # inline each math img's LaTeX from its alt attribute. two classes:
    # "latex" (inline, alt="$...$") and "latexcenter" (display, alt="\[...\]").
    def inline(m):
        return ' ' + m.group(1) + ' '
    s = re.sub(r'<img[^>]*?class="latex(?:center)?"[^>]*?alt="([^"]*)"[^>]*>', inline, html_seg)
    s = re.sub(r'<script.*?</script>', '', s, flags=re.S)
    s = re.sub(r'<[^>]+>', '\n', s)
    s = html.unescape(s)
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r'\n\s*\n+', '\n', s)
    return s

def problems_from(url):
    raw = fetch(url)
    # content headings: the LAST occurrence of each id=Problem_N is the body
    pos = {}
    for n in range(1, 7):
        pos[n] = [m.start() for m in re.finditer('id="Problem_%d"' % n, raw)][-1]
    pos[7] = len(raw)
    out = {}
    for n in range(1, 7):
        seg = clean(raw[pos[n]:pos[n + 1]])
        # drop the heading label + trailing 'Solution' nav
        seg = re.sub(r'^.*?Problem %d\s*' % n, '', seg, count=1, flags=re.S)
        seg = seg.split('Solution')[0].strip()
        out[n] = seg
    return out

base = "https://artofproblemsolving.com/wiki/index.php/2024_USAMO_Problems"
raw_file = os.path.join(os.path.dirname(__file__), "..", "..", "benchmarks", "fresh2026", "usamo2024_problems.html")
if os.path.exists(raw_file):
    raw = open(raw_file, encoding="utf-8", errors="ignore").read()
    probs = {}
    pos = {}
    for n in range(1, 7):
        pos[n] = [m.start() for m in re.finditer('id="Problem_%d"' % n, raw)][-1]
    pos[7] = len(raw)
    for n in range(1, 7):
        seg = clean(raw[pos[n]:pos[n + 1]])
        seg = re.sub(r'^.*?Problem %d\s*' % n, '', seg, count=1, flags=re.S)
        seg = seg.split('Solution')[0].strip()
        probs[n] = seg
else:
    probs = problems_from(base)

# Official answers/objects asked for by each problem (from the 2024 USAMO
# contest record / AoPS solution threads).
gold = {
    1: "n = 3 and n = 4",            # divisors-of-n! property holds only for 3,4
    2: "50 * C(100,50)",             # least elements in >=50 sets (known result)
    3: "exists iff m is a proper divisor of n",
    4: "all (m,n) with m <= n+1",    # necklace condition, from AoPS thread
    5: "line AB is tangent to the circumcircle of triangle BEM",  # pure proof
    6: "1/n + (l-1)^2/(n(n-1))",     # largest c (Evan Chen / official notes)
}

rows = []
for n in range(1, 7):
    rows.append({"id": "usamo2024-p%d" % n, "problem": probs[n], "answer": gold[n]})

out_path = os.path.join(os.path.dirname(__file__), "..", "..", "benchmarks", "data", "usamo-2024.jsonl")
with open(out_path, "w", encoding="utf-8") as f:
    for row in rows:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")

print("wrote", out_path, len(rows), "rows")
for n in range(1, 7):
    print("--- P%d ---" % n)
    print(probs[n][:400])
    print("GOLD:", gold[n])
