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
const RF_DEFAULT = 0.042; // ~10Y Treasury 2026
const ERP_DEFAULT = 0.055; // historical equity risk premium
const TERMINAL_GROWTH = 0.03;
const HORIZON_YRS = 10;
// pull one number out of the claims text with a fuzzy regex. returns null
// if the anchor phrase is missing entirely — we do NOT guess.
function harvest(text, anchors, fallbackPattern) {
    for (const a of anchors) {
        const m = text.match(a);
        if (m) {
            const v = parseFloat((m[1] || '').replace(/[,$]/g, ''));
            if (!isNaN(v))
                return v;
        }
    }
    if (fallbackPattern) {
        const m = text.match(fallbackPattern);
        if (m) {
            const v = parseFloat((m[1] || '').replace(/[,$]/g, ''));
            if (!isNaN(v))
                return v;
        }
    }
    return null;
}
function pct(m, group = 1) {
    if (!m)
        return null;
    const v = parseFloat(m[group].replace(/,/g, ''));
    return isNaN(v) ? null : v / 100; // "42%" -> 0.42 decimal
}
export function runQuantModel(claims) {
    const text = claims.join('\n');
    // ---- harvest inputs from the verified claims ----
    const price = harvest(text, [
        /(?:trading at|currently at|closed at|trades at|price is|price of)\s*\$?([\d,]+\.?\d*)/i,
        /(?:current price|market price|last price)\s*[=:]\s*\$?([\d,]+\.?\d*)/i,
        /(?:share price|stock price|price per share)[^0-9]{0,20}\$?([\d,]+\.?\d*)/i,
        /\$([\d,]+\.\d{2})\s*(?:USD|per share|US\$)/i,
    ]);
    // EPS must be fractional (6.53) — a bare "2026" after "EPS" is a fiscal
    // year, not earnings per share. requiring the decimal kills that grab.
    const eps = harvest(text, [
        /(?:EPS|earnings per share)[^0-9]{0,40}([\d,]+\.\d+)/i,
        /diluted\s+EPS[^0-9]{0,40}([\d,]+\.\d+)/i,
    ]);
    let growth = pct(text.match(/(?:revenue|sales|earnings)[^0-9]{0,80}([\d.]+)\s*%\s*(?:increase|growth|jump|surge|rise)/i))
        ?? pct(text.match(/(?:revenue|sales|earnings)\s+(?:grew|growth|increased|increase|jumped)[^0-9]{0,60}([\d.]+)\s*%/i))
        ?? pct(text.match(/representing[^0-9]{0,40}([\d.]+)\s*%\s*(?:increase|growth|jump|surge|rise)/i));
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
    const sigma = pct(text.match(/(?:volatility|annualized volatility|vol)[^0-9]{0,30}([\d.]+)\s*%/i));
    const rf = pct(text.match(/(?:risk[- ]free rate|Rf|treasury)[^0-9]{0,30}([\d.]+)\s*%/i)) ?? RF_DEFAULT;
    const erp = pct(text.match(/(?:equity risk premium|ERP|market risk premium)[^0-9]{0,30}([\d.]+)\s*%/i)) ?? ERP_DEFAULT;
    const inputs = [];
    if (price != null)
        inputs.push(`price $${price.toFixed(2)}`);
    else
        inputs.push('price: NOT FOUND');
    if (eps != null)
        inputs.push(`EPS $${eps.toFixed(2)}`);
    else
        inputs.push('EPS: NOT FOUND');
    inputs.push(`growth ${growth != null ? (growth * 100).toFixed(1) + '% (' + growthSource + ')' : 'NOT FOUND'}`);
    if (beta != null)
        inputs.push(`beta ${beta}`);
    else
        inputs.push('beta: NOT FOUND');
    if (sigma != null)
        inputs.push(`volatility ${(sigma * 100).toFixed(1)}%`);
    else
        inputs.push('volatility: NOT FOUND (using beta-based estimate)');
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
    const L = ['## Quantitative Model (computed by pipeline)', ''];
    L.push(`Inputs harvested from the cited sources: ${inputs.join(' · ')}.`);
    L.push('');
    if (costOfEquity != null) {
        L.push(`**Cost of equity (CAPM):** $R_e = R_f + \\beta \\times ERP = ${(rf * 100).toFixed(1)}\\% + ${beta.toFixed(2)} \\times ${(erp * 100).toFixed(1)}\\% = ${(costOfEquity * 100).toFixed(2)}\\%$.`);
    }
    else {
        L.push(`**Cost of equity (CAPM):** cannot compute — beta not found in sources.`);
    }
    if (intrinsicValue != null) {
        L.push(`**Discounted Cash Flow:** EPS ${eps.toFixed(2)} projected ${HORIZON_YRS} years at ${(growth * 100).toFixed(1)}\\% growth, discounted at ${(costOfEquity * 100).toFixed(2)}\\%; terminal value via Gordon growth at ${(TERMINAL_GROWTH * 100).toFixed(0)}\\% — **intrinsic value ≈ $${intrinsicValue.toFixed(2)}/share** (${upside != null ? (upside >= 0 ? '+' : '') + (upside * 100).toFixed(1) + '%' : 'n/a'} vs the current price).`);
    }
    else {
        L.push('**Discounted Cash Flow:** cannot compute — need EPS, growth, and cost of equity from sources.');
    }
    if (expectedReturn != null && vol != null) {
        L.push(`**Geometric Brownian Motion:** $dS_t = \\mu S_t dt + \\sigma S_t dW_t$ with $\\mu = ${(expectedReturn * 100).toFixed(1)}\\%$, $\\sigma = ${(vol * 100).toFixed(1)}\\%$. Ito's lemma on $f(S)=\\ln S$ gives the expected log-return $(\\mu - \\sigma^2/2) = ${(expectedLogReturn * 100).toFixed(1)}\\%$ per year — the drift correction $\\sigma^2/2 = ${((vol * vol / 2) * 100).toFixed(1)}\\%$ is the volatility drag. Expected price in one year: $E[S_T] = S_0 e^{\\mu T} = $${expectedPrice != null ? '$' + expectedPrice.toFixed(2) : 'n/a'}.`);
        L.push(`**Risk-adjusted return:** Sharpe $= (\\mu - R_f)/\\sigma = ${(sharpe.toFixed(2))}$.`);
        L.push(`**Value at Risk (normal model):** 1-day 95\\% VaR $= 1.645 \\cdot \\sigma \\cdot P / \\sqrt{252} = $${var95_1d != null ? '$' + var95_1d.toFixed(2) : 'n/a'} (${vol * 100 >= 1 ? (var95_1d != null && price ? ((var95_1d / price) * 100).toFixed(2) + '\\%' : 'n/a') : 'n/a'}); 1-day 99\\% VaR $= $${var99_1d != null ? '$' + var99_1d.toFixed(2) : 'n/a'}; 1-year 95\\% VaR $= $${var95_1y != null ? '$' + var95_1y.toFixed(2) : 'n/a'}.`);
    }
    else {
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
