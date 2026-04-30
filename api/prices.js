const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
};

const TOKEN_ALIASES = {
    caster: ['caster', 'cast', '✨❤️‍🔥🧙‍♂️'],
    xch: ['xch', 'chia', 'wxch', 'wrappedxch'],
    spellpower: ['spellpower', 'spell', '⚡️🪄'],
    bytecash: ['bytecash', 'byc', '💸'],
    love: ['love', '❤️'],
    sprout: ['sprout', '🌱'],
    pizza: ['pizza', '🍕'],
    bepe: ['bepe', '$bepe'],
    honk: ['honk', '$honk', '🪿'],
    neckcoin: ['neckcoin', 'neck', '$neck'],
    vfvapatek9000inu: ['vfvapatek9000inu', '$chia', 'chia-meme'],
    hodl: ['hodl', '$hodl', '💎'],
    hoa: ['hoa', '🍊'],
    wizardbucks: ['wizardbucks', 'wiz', '🧙💸']
};

function normalizeText(v) {
    return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveTokenKey(raw) {
    const q = normalizeText(raw);
    if (!q) return '';
    for (const [key, aliases] of Object.entries(TOKEN_ALIASES)) {
        if (aliases.some(a => normalizeText(a) === q)) return key;
    }
    return q;
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

function toRow(token) {
    const resolvedKey = resolveTokenKey(token.displayName || token.name || token.symbol || token.id || '');
    const aliasSet = new Set(TOKEN_ALIASES[resolvedKey] || []);
    aliasSet.add((token.displayName || token.name || '').toLowerCase());
    aliasSet.add((token.symbol || '').toLowerCase());

    return {
        id: token.id || null,
        key: resolvedKey || null,
        ticker: resolvedKey ? resolvedKey.toUpperCase() : null,
        aliases: Array.from(aliasSet).filter(Boolean),
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

        const tokenQuery = req.query?.token || req.query?.symbol || req.query?.name || '';
        const tokenKey = resolveTokenKey(tokenQuery);
        const filtered = tokenKey
            ? all.filter(t => t.key === tokenKey || normalizeText(t.name) === tokenKey || normalizeText(t.displayName) === tokenKey)
            : all;

        const filteredBase = tokenKey ? base.filter(t => filtered.includes(t)) : base;
        const filteredChia = tokenKey ? chia.filter(t => filtered.includes(t)) : chia;

        return res.status(200).json({
            ok: true,
            generatedAt: Date.now(),
            source: snapshot.source || 'unknown',
            savedAt: snapshot.savedAt || null,
            token: tokenKey || null,
            counts: {
                all: filtered.length,
                base: filteredBase.length,
                chia: filteredChia.length,
                priced: filtered.filter(t => t.price > 0).length
            },
            prices: filtered,
            byChain: { base: filteredBase, chia: filteredChia }
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'prices_failed' });
    }
}
