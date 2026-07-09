// thinking/confidence.ts
export function bucket(type) {
    return String(type || 'string').toLowerCase();
}
export function makeCalibrator(initial = {}) {
    const stats = {};
    for (const [k, v] of Object.entries(initial)) {
        stats[k] = {
            attempts: v.attempts || 0,
            wins: v.wins || 0,
            history: Array.isArray(v.history) ? v.history.slice(-200) : []
        };
    }
    return {
        record(type, passed) {
            const k = bucket(type);
            const s = stats[k] || (stats[k] = { attempts: 0, wins: 0, history: [] });
            s.attempts++;
            if (passed)
                s.wins++;
            s.history.push(passed ? 1 : 0);
            if (s.history.length > 200)
                s.history.shift();
            return s;
        },
        rate(type) {
            const s = stats[bucket(type)];
            if (!s || !s.attempts)
                return 0.5;
            return s.wins / s.attempts;
        },
        confidenceFor(type) {
            const r = this.rate(type);
            // blend with a 0.5 prior so small N leans toward 0.5 instead of zero
            const n = stats[bucket(type)]?.attempts || 0;
            const weight = Math.min(1, n / 10);
            return weight * r + (1 - weight) * 0.5;
        },
        summary() {
            const out = {};
            for (const [k, v] of Object.entries(stats)) {
                out[k] = {
                    attempts: v.attempts,
                    wins: v.wins,
                    rate: v.attempts ? v.wins / v.attempts : 0,
                    confidence: this.confidenceFor(k)
                };
            }
            return out;
        },
        snapshot() {
            return JSON.parse(JSON.stringify(stats));
        }
    };
}
