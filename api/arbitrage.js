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
        const minSpreadPct = Math.max(0, asNumber(req.query?.minSpreadPct || 0));
        const origin = getOrigin(req);

        // ── 1. Get token registry from blob cache (fast, just need ids/contracts/assetIds) ──
        const snapshotResp = await safeFetch(`${origin}/api/market-index`, 12000);
        if (!snapshotResp.ok) {
            return res.status(502).json({ ok: false, error: `market_index_${snapshotResp.status}` });
        }
        const snapshot = await snapshotResp.json();
        const baseTokens = Array.isArray(snapshot.base) ? snapshot.base : [];
        const chiaTokens = Array.isArray(snapshot.chia) ? snapshot.chia : [];

        // ── 2. Fetch LIVE prices in parallel — Dexie (Chia) + DexScreener (Base) + XCH/USD ──
        const baseContracts = baseTokens.filter(t => t.contract).map(t => t.contract.toLowerCase());
        const [xchResp, dexieTickers, dexscreenerRaw] = await Promise.all([
            // XCH/USD from CoinGecko proxy
            safeFetch(`${origin}/api/coingecko-proxy?ids=chia&vs_currencies=usd`, 8000)
                .then(r => r.ok ? r.json() : {}).catch(() => ({})),
            // All Chia CAT prices in one call — last_price is price-in-XCH
            fetch('https://dexie.space/v2/prices/tickers', { headers: { Accept: 'application/json' } })
                .then(r => r.ok ? r.json() : {}).catch(() => ({})),
            // All Base token prices in one batch call
            baseContracts.length > 0
                ? fetch(`https://api.dexscreener.com/tokens/v1/base/${baseContracts.join(',')}`, { headers: { Accept: 'application/json' } })
                    .then(r => r.ok ? r.json() : []).catch(() => [])
                : Promise.resolve([]),
        ]);

        // ── 3. Build live price maps ──
        const xchUsd = asNumber(xchResp?.chia?.usd) || 2.20;

        // Dexie: assetId → liveUsd
        const dexiePriceMap = {};
        for (const tick of (dexieTickers.tickers || [])) {
            const aid = (tick.base_id || '').toLowerCase();
            const lp = asNumber(tick.last_price);
            if (aid && lp > 0) dexiePriceMap[aid] = lp * xchUsd;
        }

        // DexScreener: contract (lowercase) → liveUsd (best-volume pair)
        const dexPriceMap = {};
        const pairs = Array.isArray(dexscreenerRaw) ? dexscreenerRaw : (dexscreenerRaw?.pairs || []);
        for (const p of pairs) {
            if (p.chainId && p.chainId !== 'base') continue;
            const quote = (p.quoteToken?.symbol || '').toUpperCase();
            if (!['WETH', 'USDC', 'ETH', 'USDT', 'WXCH', 'XCH'].includes(quote)) continue;
            const ca = (p.baseToken?.address || '').toLowerCase();
            const price = asNumber(p.priceUsd);
            const vol = asNumber(p.volume?.h24);
            if (ca && price > 0 && (!dexPriceMap[ca] || vol > (dexPriceMap[ca].vol || 0))) {
                dexPriceMap[ca] = { price, vol, change24h: asNumber(p.priceChange?.h24) };
            }
        }

        // ── 4. Merge live prices into token records (fall back to snapshot price if live missed) ──
        function livePrice(token) {
            if (token.chain === 'Chia' && token.assetId && token.assetId !== 'Native') {
                return dexiePriceMap[token.assetId.toLowerCase()] || asNumber(token.price);
            }
            if (token.chain === 'Base' && token.contract) {
                return dexPriceMap[token.contract.toLowerCase()]?.price || asNumber(token.price);
            }
            if (token.chain === 'Chia' && token.assetId === 'Native') return xchUsd;
            return asNumber(token.price);
        }

        // ── 5. Build pairing maps with live prices ──
        const baseMap = new Map();
        const chiaMap = new Map();

        for (const token of baseTokens) {
            const key = pairingKey(token);
            const price = livePrice(token);
            if (!key || price <= 0) continue;
            baseMap.set(key, { ...token, price });
        }

        for (const token of chiaTokens) {
            const key = pairingKey(token);
            const price = livePrice(token);
            if (!key || price <= 0) continue;
            chiaMap.set(key, { ...token, price });
        }

        // ── 6. Compute spreads ──
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
                    marketCap: asNumber(b.marketCap),
                },
                chia: {
                    price: chiaPrice,
                    assetId: c.assetId || null,
                    change24h: asNumber(c.change24h),
                    marketCap: asNumber(c.marketCap),
                },
                spreadAbs,
                spreadPct,
                absSpreadPct,
                direction,
            });
        }

        opportunities.sort((a, b) => b.absSpreadPct - a.absSpreadPct);

        return res.status(200).json({
            ok: true,
            generatedAt: Date.now(),
            priceSource: 'live',
            snapshotAge: snapshot.savedAt ? Date.now() - snapshot.savedAt : null,
            xchUsd,
            minSpreadPct,
            opportunities,
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'arbitrage_failed' });
    }
}
