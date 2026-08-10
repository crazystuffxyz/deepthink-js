# Benchmarks

Public benchmark numbers for `deepthink-js` against
`gemma4:31b-cloud` on Ollama. The harness is plain Node — no Python
dependency. It pulls questions from public official sources (HuggingFace
+ openai/grade-school-math github), runs each question through both
**plain ollama** and **Deepthink** with `depth=3, checks=2`, then writes
a per-row CSV and a summary JSON.

## Datasets

| Source | File | License | Origin |
|---|---|---|---|
| [Maxwell-Jia/AIME_2024](https://huggingface.co/datasets/Maxwell-Jia/AIME_2024) | `data/aime2024.jsonl` | CC-BY-4.0 | AIME 2024 I+II contest problems |
| [openai/grade-school-math](https://github.com/openai/grade-school-math) | `data/gsm8k.jsonl` | MIT | GSM8K grade-school word problems |
| [HuggingFaceH4/MATH-500](https://huggingface.co/datasets/HuggingFaceH4/MATH-500) | `data/math500.jsonl` | MIT | MATH-500 competition problems |

The data files are not committed. To regenerate them:

```bash
# from the repo root
curl -fsSL "https://huggingface.co/datasets/Maxwell-Jia/AIME_2024/resolve/main/aime_2024_problems.parquet" -o /tmp/aime.parquet
python3 -c "import pandas as pd, json; df=pd.read_parquet('/tmp/aime.parquet'); [print(json.dumps({'id':r.ID,'source':'AIME 2024','kind':'math','problem':r.Problem,'answer':str(r.Answer).strip()})) for r in df.itertuples()]" > benchmarks/data/aime2024.jsonl

curl -fsSL "https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl" -o /tmp/gsm8k.jsonl
python3 -c "import json; [print(json.dumps({'id':f'gsm8k-{i}','source':'GSM8K','kind':'math','problem':r['question'],'answer':r['answer'].split('####')[-1].strip().replace(',','')})) for i,r in enumerate((json.loads(l) for l in open('/tmp/gsm8k.jsonl'))[:200])]" > benchmarks/data/gsm8k.jsonl

curl -fsSL "https://huggingface.co/datasets/HuggingFaceH4/MATH-500/resolve/main/test.jsonl?download=true" -o /tmp/math500.jsonl
python3 -c "import json,re; [(lambda r: print(json.dumps({'id':r['unique_id'],'source':'MATH-500','kind':'math','problem':r['problem'],'answer':(re.findall(r'\\\\boxed\\{([^}]*)\}', r['solution']) or [r['answer']])[-1]})))(json.loads(l)) for l in list(open('/tmp/math500.jsonl'))[:200]]" > benchmarks/data/math500.jsonl
```

## Run

```bash
# one benchmark
node scripts/benchmarks/run.js --bench aime2024 --depth 3 --checks 2 --out benchmarks/results_aime.csv

# all three, then join
node scripts/benchmarks/run.js --bench gsm8k --depth 3 --checks 2 --out benchmarks/results_gsm8k.csv
node scripts/benchmarks/run.js --bench math500 --depth 3 --checks 2 --out benchmarks/results_math500.csv
node scripts/benchmarks/join.js
```

The `join.js` script concatenates the per-bench CSVs into
`benchmarks/results.csv`, writes a summary JSON, and regenerates the
README table at `benchmarks/results.table.md`.

## Output

`results.csv` columns:

```
bench,id,gold,plain_answer,plain_correct,dt_answer,dt_correct,dt_seconds
```

`results.summary.json` has per-bench accuracy totals and the
plain-vs-deepthink delta. `results.table.md` is the rendered markdown
table for the README.
