/**
 * Live Chia CAT USD prices — Dexie tickers + server batch fallback.
 */

async function safeFetch(url, timeout = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json' }
        });
        clearTimeout(timer);
        return response;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

/**
 * @param {string} origin - e.g. https://caster101.vercel.app
 * @returns {Promise<{ xchUsd: number, prices: Record<string, number>, changes: Record<string, number> }>}
 */
export async function fetchLiveChiaPriceData(origin) {
    const [xchResp, dexieTickers, catBatch] = await Promise.all([
        safeFetch(`${origin}/api/coingecko-proxy?ids=chia&vs_currencies=usd&include_24hr_change=true`, 8000)
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({})),
        safeFetch('https://dexie.space/v2/prices/tickers', 8000)
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({})),
        safeFetch(`${origin}/api/chia-cat-prices?t=${Date.now()}`, 20000)
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({}))
    ]);

    let xchUsd = parseFloat(xchResp?.chia?.usd || 0);
    if (xchUsd <= 0) xchUsd = 2.20;

    const prices = {};
    const changes = {};

    for (const tick of (dexieTickers.tickers || [])) {
        const aid = (tick.base_id || '').toLowerCase();
        const lp = parseFloat(tick.last_price || 0);
        if (aid && lp > 0) prices[aid] = lp * xchUsd;
    }

    const batchPrices = catBatch?.prices || {};
    const batchChanges = catBatch?.changes || {};
    for (const [id, p] of Object.entries(batchPrices)) {
        const px = parseFloat(p || 0);
        if (px > 0 && !prices[id.toLowerCase()]) prices[id.toLowerCase()] = px;
        if (batchChanges[id] !== undefined) changes[id.toLowerCase()] = parseFloat(batchChanges[id] || 0);
    }

    return { xchUsd, prices, changes };
}
