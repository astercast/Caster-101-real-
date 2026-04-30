const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
};

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

function toRow(token) {
    return {
        id: token.id || null,
        chain: token.chain || null,
        name: token.name || null,
        displayName: token.displayName || token.name || null,
        symbol: token.symbol || null,
        assetId: token.assetId || null,
        contract: token.contract || null,
        price: parseFloat(token.price || 0),
        change24h: parseFloat(token.change24h || 0),
        marketCap: parseFloat(token.marketCap || 0)
    };
}

export default async function handler(req, res) {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    try {
        const force = req.query?.refresh === '1' || req.query?.fresh === '1';
        const origin = getOrigin(req);
        const marketUrl = `${origin}/api/market-index${force ? '?refresh=1' : ''}${force ? '&' : '?'}t=${Date.now()}`;
        const marketResp = await safeFetch(marketUrl, 25000);

        if (!marketResp.ok) {
            return res.status(502).json({ ok: false, error: `market_index_${marketResp.status}` });
        }

        const snapshot = await marketResp.json();
        const base = Array.isArray(snapshot.base) ? snapshot.base.map(toRow) : [];
        const chia = Array.isArray(snapshot.chia) ? snapshot.chia.map(toRow) : [];
        const all = [...base, ...chia];

        return res.status(200).json({
            ok: true,
            generatedAt: Date.now(),
            source: snapshot.source || 'unknown',
            savedAt: snapshot.savedAt || null,
            counts: {
                all: all.length,
                base: base.length,
                chia: chia.length,
                priced: all.filter(t => t.price > 0).length
            },
            prices: all,
            byChain: { base, chia }
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'prices_failed' });
    }
}
