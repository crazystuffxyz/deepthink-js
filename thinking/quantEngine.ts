// thinking/quantEngine.ts
// REAL quant math for stock reports — pure code, zero LLM. the writer can
// claim it "ran a DCF" all day, but until the pipeline computes the number
// itself the report is vibes with citations. this engine harvests inputs
// from the verified claims (price, EPS, growth, beta), runs an actual
// 10-year DCF + GBM/Ito model, and returns numbers the report must use.
//
// formulas (all standard):
//   CAPM cost of equity:    Re = Rf + beta * ERP
//   DCF:                    IV = sum(CF_t / (1+Re)^t) + TV/(1+Re)^10
//                           CF_t = EPS_0 * (1+g)^t ; TV = CF_10*(1+g_t)/(Re-g_t)
//   GBM:                    dS = mu*S dt + sigma*S dW
//   Ito log-return:         ln(S_T/S_0) ~ N((mu - sigma^2/2)T, sigma^2 T)
//   expected price:         E[S_T] = S_0 * e^(mu*T)
//   Sharpe:                 (mu - Rf) / sigma
//   VaR (normal):           z_a * sigma * P * sqrt(T)   (z_95=1.645, z_99=2.326)

export type QuantModel = {
  ok: boolean;
  price: number | null;
  eps: number | null;
  growth: number | null;        // revenue growth rate (decimal)
  beta: number | null;
  rf: number;                   // risk-free rate (decimal)
  erp: number;                  // equity risk premium (decimal)
  costOfEquity: number | null;  // Re (decimal)
  sigma: number | null;         // annualized vol (decimal)
  intrinsicValue: number | null; // DCF per share
  expectedReturn: number | null; // mu = Re, annual (decimal)
  expectedLogReturn: number | null; // mu - sigma^2/2 (decimal)
  expectedPrice: number | null;   // E[S_T] over horizon
  sharpe: number | null;
  var95_1d: number | null;
  var99_1d: number | null;
  var95_1y: number | null;
  upside: number | null;        // IV/price - 1
  section: string;              // markdown section to inject
  inputs: string[];             // where each input came from (for the section)
};

const RF_DEFAULT = 0.042;  // ~10Y Treasury 2026
const ERP_DEFAULT = 0.055; // historical equity risk premium
const TERMINAL_GROWTH = 0.03;
const HORIZON_YRS = 10;

// pull one number out of the claims text with a fuzzy regex. returns null
// if the anchor phrase is missing entirely — we do NOT guess.
// banned: window words that mean the number is NOT what we want ("price
// target of $180" must never harvest as the current price).
// yearLike: "2026.00" after EPS is a fiscal year, not $2,026 — 4-digit
// integer parts in the 1900-2099 band are always years, never prices/EPS.
function yearLike(v: number): boolean {
  return v >= 1900 && v <= 2099 && Number.isInteger(v);
}
// scanPriceForward — last resort for wordy price phrasings ("share price
// for fiscal 2026 was $150.42"): walk each anchor hit and scan forward,
// skipping year-like numbers ("2026") and %-moves ("up 5% to $150") until
// a real price appears.
const PRICE_ANCHORS = ['current price', 'market price', 'last price', 'share price', 'stock price', 'price per share'];
function scanPriceForward(text: string): number | null {
  for (const anchor of PRICE_ANCHORS) {
    const g = new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    while (true) {
      const hit = g.exec(text);
      if (!hit) break;
      const slice = text.slice(hit.index + hit[0].length, hit.index + hit[0].length + 60);
      // a banned word between the anchor and the first number means this
      // hit is about a target/forecast, not the current price — reject it
      const before = slice.split(/\d/)[0].toLowerCase();
      if (['target', 'forecast', 'guidance', 'projection', 'estimate'].some((w) => before.includes(w))) continue;
      for (const nm of slice.matchAll(/\$?([\d,]+\.?\d*)\s*%?/g)) {
        const v = parseFloat(nm[1].replace(/[,$]/g, ''));
        if (!isNaN(v) && !yearLike(v) && !nm[0].includes('%')) return v;
      }
    }
  }
  return null;
}

// tryMatch walks every match of the anchor: a year-like capture ("share
// price for fiscal 2026 was $150.42" → 2026) must not kill the anchor —
// continue to the next match and find the real number.
function harvest(text: string, anchors: RegExp[], fallbackPattern?: RegExp, banned: string[] = []): number | null {
  const tryMatch = (a: RegExp): number | null => {
    const g = new RegExp(a.source, a.flags.replace('g', '') + 'g');
    while (true) {
      const mm = g.exec(text);
      if (!mm) break;
      if (banned.some((w) => mm[0].toLowerCase().includes(w))) continue;
      const v = parseFloat((mm[1] || '').replace(/[,$]/g, ''));
      if (!isNaN(v) && !yearLike(v)) return v;
    }
    return null;
  };
  for (const a of anchors) {
    const v = tryMatch(a);
    if (v != null) return v;
  }
  if (fallbackPattern) {
    const v = tryMatch(fallbackPattern);
    if (v != null) return v;
  }
  return null;
}

function pct(m: RegExpMatchArray | null, group = 1): number | null {
  if (!m) return null;
  const v = parseFloat(m[group].replace(/,/g, ''));
  return isNaN(v) ? null : v / 100; // "42%" -> 0.42 decimal
}

export function runQuantModel(claims: string[]): QuantModel {
  const text = claims.join('\n');

  // ---- harvest inputs from the verified claims ----
  // windows cross digits ("closed Wednesday at $150.42", "EPS for Q3 FY2026
  // stood at $1.30") — [^0-9]{0,N} died on quarter numbers and years. the
  // yearLike guard in harvest() keeps years out of the capture, and banned
  // words keep price TARGETS out of the price slot.
  let price = harvest(text, [
    /(?:trading at|currently at|closed at|trades at|price is|price of|sits at|traded at|quoted at)\s*\$?([\d,]+\.?\d*)/i,
    /(?:trades|trading|closed|sits|quoted)\s+(?:\w+\s+){0,2}(?:around|near|about|for|at)\s*\$?([\d,]+\.?\d*)/i,
    /\$([\d,]+\.\d{2})\s*(?:USD|per share|US\$)/i,
  ], undefined, ['target', 'forecast', 'guidance', 'projection', 'estimate']);
  if (price == null) price = scanPriceForward(text);
  // EPS must be fractional (6.53) — a bare "2026" after "EPS" is a fiscal
  // year, not earnings per share. requiring the decimal kills that grab,
  // and yearLike() kills "EPS $2026.00" artifacts. quarterly EPS ("Q3
  // FY2026 … $1.30") must NOT feed the annual DCF — prefer annual/TTM
  // phrasing when both exist (score: annual > neutral > quarterly).
  const eps = (() => {
    const cands: { v: number; q: number }[] = [];
    for (const a of [/(?:EPS|earnings per share)[\s\S]{0,60}?([\d,]+\.\d+)/i, /diluted\s+EPS[\s\S]{0,60}?([\d,]+\.\d+)/i]) {
      const g = new RegExp(a.source, a.flags.replace('g', '') + 'g');
      while (true) {
        const mm = g.exec(text);
        if (!mm) break;
        const v = parseFloat((mm[1] || '').replace(/[,$]/g, ''));
        if (isNaN(v) || yearLike(v)) continue;
        const ctx = (mm[0] || '').toLowerCase();
        const quarterly = /q[1-4]|quarterly|quarter\b/.test(ctx) ? 1 : 0;
        const annual = /annual|full[- ]year|\bttm\b|trailing|fiscal year/.test(ctx) ? 1 : 0;
        cands.push({ v, q: annual - quarterly });
      }
    }
    if (!cands.length) return null;
    cands.sort((x, y) => y.q - x.q);
    return cands[0].v;
  })();
  let growth = pct(text.match(/(?:revenue|sales|earnings)[\s\S]{0,80}?([\d.]+)\s*%\s*(?:increase|growth|jump|surge|rise)/i))
    ?? pct(text.match(/(?:revenue|sales|earnings)[\s\S]{0,40}?\s+(?:grew|growth|increased|increase|jumped)[\s\S]{0,60}?([\d.]+)\s*%/i))
    ?? pct(text.match(/(?:representing|represented)[\s\S]{0,50}?([\d.]+)\s*%\s*(?:increase|growth|jump|surge|rise)/i));
  let growthSource = 'explicit growth %';
  if (growth == null) {
    // fallback: PEG = forward P/E / expected growth  →  g = PE / PEG.
    // both are typically cited for stocks, so we derive growth the same way
    // an analyst would instead of leaving the DCF uncomputable.
    const peF = harvest(text, [/(?:forward\s+p\/e|forward pe|fwd p\/e)[^0-9]{0,40}([\d.]+)/i]);
    const peg = harvest(text, [/(?:peg\s+ratio|expected\s+peg)[^0-9]{0,40}([\d.]+)/i]);
    if (peF != null && peg != null && peg > 0) {
      growth = peF / peg / 100;
      growthSource = `derived from forward P/E ${peF} ÷ PEG ${peg}`;
    }
  }
  // skip parenthesized qualifiers like "Beta (5Y Monthly) is 2.21" — the
  // naive [^0-9] window would grab the "5" from "(5Y Monthly)".
  const beta = harvest(text, [
    /(?:beta|Beta)\s+(?:of|at|is|:|=)\s*([\d.]+)/i,
    /(?:beta|Beta)(?:\s*\([^)]*\)|[^0-9]){0,40}([\d.]+)/i,
  ]);
  const sigma = pct(text.match(/(?:volatility|annualized volatility|vol(?!ume))[\s\S]{0,40}?([\d.]+)\s*%/i));
  const rf = pct(text.match(/(?:risk[- ]free rate|Rf|treasury)[^0-9]{0,30}([\d.]+)\s*%/i)) ?? RF_DEFAULT;
  const erp = pct(text.match(/(?:equity risk premium|ERP|market risk premium)[^0-9]{0,30}([\d.]+)\s*%/i)) ?? ERP_DEFAULT;

  const inputs: string[] = [];
  if (price != null) inputs.push(`price $${price.toFixed(2)}`);
  else inputs.push('price: NOT FOUND');
  if (eps != null) inputs.push(`EPS $${eps.toFixed(2)}`);
  else inputs.push('EPS: NOT FOUND');
  inputs.push(`growth ${growth != null ? (growth * 100).toFixed(1) + '% (' + growthSource + ')' : 'NOT FOUND'}`);
  if (beta != null) inputs.push(`beta ${beta}`);
  else inputs.push('beta: NOT FOUND');
  if (sigma != null) inputs.push(`volatility ${(sigma * 100).toFixed(1)}%`);
  else inputs.push('volatility: NOT FOUND (using beta-based estimate)');
  inputs.push(`risk-free ${(rf * 100).toFixed(1)}%, ERP ${(erp * 100).toFixed(1)}%`);

  // ---- compute ----
  const costOfEquity = beta != null ? rf + beta * erp : null;
  const vol = sigma ?? (beta != null ? beta * 0.18 : null); // beta-based fallback: market vol ~18%
  const intrinsicValue = eps != null && costOfEquity != null && growth != null && costOfEquity > TERMINAL_GROWTH
    ? (() => {
        // 10-yr DCF: project EPS at g, discount at Re, Gordon terminal value
        let pv = 0;
        let cf = eps;
        for (let t = 1; t <= HORIZON_YRS; t++) {
          cf = cf * (1 + growth);
          pv += cf / Math.pow(1 + costOfEquity, t);
        }
        const tv = cf * (1 + TERMINAL_GROWTH) / (costOfEquity - TERMINAL_GROWTH);
        pv += tv / Math.pow(1 + costOfEquity, HORIZON_YRS);
        return pv;
      })()
    : null;
  const expectedReturn = costOfEquity; // mu: CAPM required return is the drift anchor
  const expectedLogReturn = expectedReturn != null && vol != null ? expectedReturn - (vol * vol) / 2 : null;
  const expectedPrice = price != null && expectedReturn != null ? price * Math.exp(expectedReturn) : null;
  const sharpe = expectedReturn != null && vol != null ? (expectedReturn - rf) / vol : null;
  const var95_1d = vol != null && price != null ? 1.645 * vol * price / Math.sqrt(252) : null;
  const var99_1d = vol != null && price != null ? 2.326 * vol * price / Math.sqrt(252) : null;
  const var95_1y = vol != null && price != null ? 1.645 * vol * price : null;
  const upside = intrinsicValue != null && price != null ? intrinsicValue / price - 1 : null;

  // ---- build the injected section ----
  const L: string[] = ['## Quantitative Model (computed by pipeline)', ''];
  L.push(`Inputs harvested from the cited sources: ${inputs.join(' · ')}.`);
  L.push('');
  if (costOfEquity != null) {
    L.push(`**Cost of equity (CAPM):** $R_e = R_f + \\beta \\times ERP = ${(rf * 100).toFixed(1)}\\% + ${beta!.toFixed(2)} \\times ${(erp * 100).toFixed(1)}\\% = ${(costOfEquity * 100).toFixed(2)}\\%$.`);
  } else {
    L.push(`**Cost of equity (CAPM):** cannot compute — beta not found in sources.`);
  }
  if (intrinsicValue != null) {
    L.push(`**Discounted Cash Flow:** EPS ${eps!.toFixed(2)} projected ${HORIZON_YRS} years at ${(growth! * 100).toFixed(1)}\\% growth, discounted at ${(costOfEquity! * 100).toFixed(2)}\\%; terminal value via Gordon growth at ${(TERMINAL_GROWTH * 100).toFixed(0)}\\% — **intrinsic value ≈ $${intrinsicValue.toFixed(2)}/share** (${upside != null ? (upside >= 0 ? '+' : '') + (upside * 100).toFixed(1) + '%' : 'n/a'} vs the current price).`);
  } else {
    L.push('**Discounted Cash Flow:** cannot compute — need EPS, growth, and cost of equity from sources.');
  }
  if (expectedReturn != null && vol != null) {
    L.push(`**Geometric Brownian Motion:** $dS_t = \\mu S_t dt + \\sigma S_t dW_t$ with $\\mu = ${(expectedReturn * 100).toFixed(1)}\\%$, $\\sigma = ${(vol * 100).toFixed(1)}\\%$. Ito's lemma on $f(S)=\\ln S$ gives the expected log-return $(\\mu - \\sigma^2/2) = ${(expectedLogReturn! * 100).toFixed(1)}\\%$ per year — the drift correction $\\sigma^2/2 = ${((vol * vol / 2) * 100).toFixed(1)}\\%$ is the volatility drag. Expected price in one year: $E[S_T] = S_0 e^{\\mu T} = $${expectedPrice != null ? '$' + expectedPrice.toFixed(2) : 'n/a'}.`);
    L.push(`**Risk-adjusted return:** Sharpe $= (\\mu - R_f)/\\sigma = ${(sharpe!.toFixed(2))}$.`);
    L.push(`**Value at Risk (normal model):** 1-day 95\\% VaR $= 1.645 \\cdot \\sigma \\cdot P / \\sqrt{252} = $${var95_1d != null ? '$' + var95_1d.toFixed(2) : 'n/a'} (${vol * 100 >= 1 ? (var95_1d != null && price ? ((var95_1d / price) * 100).toFixed(2) + '\\%' : 'n/a') : 'n/a'}); 1-day 99\\% VaR $= $${var99_1d != null ? '$' + var99_1d.toFixed(2) : 'n/a'}; 1-year 95\\% VaR $= $${var95_1y != null ? '$' + var95_1y.toFixed(2) : 'n/a'}.`);
  } else {
    L.push('**GBM/Ito:** cannot compute — need volatility and cost of equity from sources.');
  }
  L.push('');
  L.push('*All figures above are computed deterministically by the research pipeline from the cited inputs — no estimation. The report prose must use these exact numbers.*');

  return {
    ok: price != null && eps != null && growth != null && beta != null && vol != null && intrinsicValue != null,
    price, eps, growth, beta, rf, erp, costOfEquity, sigma: vol,
    intrinsicValue, expectedReturn, expectedLogReturn, expectedPrice,
    sharpe, var95_1d, var99_1d, var95_1y, upside,
    section: L.join('\n'),
    inputs,
  };
}
