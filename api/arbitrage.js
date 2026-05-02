const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
};

// Strip chain suffix from token id to get a pairing key.
// e.g. 'caster-chia' → 'caster', 'caster-base' → 'caster'
// Falls back to normalizeName(token.name) for tokens without a structured id.
function pairingKey(token) {
    const id = String(token.id || '');
    if (id.endsWith('-chia')) return id.slice(0, -5);
    if (id.endsWith('-base')) return id.slice(0, -5);
    // Fallback: strip non-alphanumeric from name
    return String(token.name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getOrigin(req) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

async function safeFetch(url, timeout = 25000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        clearTimeout(timer);
        return response;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

function asNumber(v) {
    const n = parseFloat(v || 0);
    return Number.isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    try {
        const force = req.query?.refresh === '1' || req.query?.fresh === '1';
        const minSpreadPct = Math.max(0, asNumber(req.query?.minSpreadPct || 0));
        const origin = getOrigin(req);
        const marketUrl = `${origin}/api/market-index${force ? '?refresh=1' : ''}${force ? '&' : '?'}t=${Date.now()}`;
        const marketResp = await safeFetch(marketUrl, 25000);

        if (!marketResp.ok) {
            return res.status(502).json({ ok: false, error: `market_index_${marketResp.status}` });
        }

        const snapshot = await marketResp.json();
        const base = Array.isArray(snapshot.base) ? snapshot.base : [];
        const chia = Array.isArray(snapshot.chia) ? snapshot.chia : [];

        const baseMap = new Map();
        const chiaMap = new Map();

        for (const token of base) {
            const key = pairingKey(token);
            const price = asNumber(token.price);
            if (!key || price <= 0) continue;
            baseMap.set(key, token);
        }

        for (const token of chia) {
            const key = pairingKey(token);
            const price = asNumber(token.price);
            if (!key || price <= 0) continue;
            chiaMap.set(key, token);
        }

        const opportunities = [];
        for (const [key, b] of baseMap.entries()) {
            const c = chiaMap.get(key);
            if (!c) continue;

            const basePrice = asNumber(b.price);
            const chiaPrice = asNumber(c.price);
            if (basePrice <= 0 || chiaPrice <= 0) continue;

            const spreadAbs = basePrice - chiaPrice;
            const spreadPct = (spreadAbs / chiaPrice) * 100;
            const absSpreadPct = Math.abs(spreadPct);
            if (absSpreadPct < minSpreadPct) continue;

            const direction = spreadPct >= 0
                ? 'buy_chia_sell_base'
                : 'buy_base_sell_chia';

            opportunities.push({
                key,
                name: c.displayName || c.name || b.displayName || b.name || key,
                symbol: c.symbol || b.symbol || null,
                base: {
                    price: basePrice,
                    contract: b.contract || null,
                    change24h: asNumber(b.change24h),
                    marketCap: asNumber(b.marketCap)
                },
                chia: {
                    price: chiaPrice,
                    assetId: c.assetId || null,
                    change24h: asNumber(c.change24h),
                    marketCap: asNumber(c.marketCap)
                },
                spreadAbs,
                spreadPct,
                absSpreadPct,
                direction
            });
        }

        opportunities.sort((a, b) => b.absSpreadPct - a.absSpreadPct);

        return res.status(200).json({
            ok: true,
            generatedAt: Date.now(),
            source: snapshot.source || 'unknown',
            savedAt: snapshot.savedAt || null,
            minSpreadPct,
            opportunities
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'arbitrage_failed' });
    }
}
