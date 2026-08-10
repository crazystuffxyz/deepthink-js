# Deepthink vs Plain Ollama — minimax-m3:cloud (deepthink d=2, c=2)

> sympy-backed code-execution verification on every math row. critique by `gemma4:31b-cloud` (2 calls total, one per HTML).

| Benchmark | n | Plain ollama | Deepthink | Δ (dt - plain) | Code-exec agreement |
|---|---:|---:|---:|---:|---|
| AIME 2024 I | 5 | 80.0% | 80.0% | 0 | 4/5 vs 4/5 |
| AIME 2024 II | 5 | 40.0% | 60.0% | +1 | 2/5 vs 3/5 |
| AIME 2023 I | 5 | 60.0% | 80.0% | +1 | 3/5 vs 4/5 |
| USAMO 2024 | 6 | 16.7% | 33.3% | +1 | 1/6 vs 2/6 |
| IMO 2024 | 6 | 66.7% | 16.7% | -3 | 4/6 vs 1/6 |
| Integration Bee | 2 | 50.0% | 50.0% | 0 | 1/2 vs 1/2 |
| Coding (critique) | 1 | total=40/50 | total=38/50 | -2 | n/a |

