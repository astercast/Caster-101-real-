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

async function safeFetch(url, timeout = 20000) {
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

function mapMeta(token) {
    return {
        id: token.id || null,
        chain: token.chain || null,
        name: token.name || null,
        displayName: token.displayName || token.name || null,
        symbol: token.symbol || null,
        assetId: token.assetId || null,
        contract: token.contract || null,
        decimals: null
    };
}

export default async function handler(req, res) {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    try {
        const origin = getOrigin(req);
        const marketResp = await safeFetch(`${origin}/api/market-index?t=${Date.now()}`, 20000);
        if (!marketResp.ok) {
            return res.status(502).json({ ok: false, error: `market_index_${marketResp.status}` });
        }

        const snapshot = await marketResp.json();
        const base = Array.isArray(snapshot.base) ? snapshot.base.map(mapMeta) : [];
        const chia = Array.isArray(snapshot.chia) ? snapshot.chia.map(mapMeta) : [];

        return res.status(200).json({
            ok: true,
            generatedAt: Date.now(),
            source: snapshot.source || 'unknown',
            savedAt: snapshot.savedAt || null,
            counts: {
                all: base.length + chia.length,
                base: base.length,
                chia: chia.length
            },
            tokens: [...base, ...chia],
            byChain: { base, chia }
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'metadata_failed' });
    }
}
