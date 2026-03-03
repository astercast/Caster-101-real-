const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
};

const INDEX_KEY = 'caster101-index/market.json';
const MEM_TTL_MS = 60 * 1000;         // in-memory hot cache: 1 min
const BLOB_TTL_MS = 10 * 60 * 1000;   // blob SWR threshold: 10 min — older → background rebuild

let _memSnapshot = null;
let _memAt = 0;
let _inflight = null;

const TRACKED = {
    chia: [
        { id: 'xch', symbol: 'XCH', name: 'Chia', chain: 'Chia', assetId: 'Native' },
        { id: 'caster-chia', symbol: '✨❤️‍🔥🧙‍♂️', name: 'Caster', chain: 'Chia', assetId: 'a09af8b0d12b27772c64f89cf0d1db95186dca5b1871babc5108ff44f36305e6' },
        { id: 'spellpower-chia', symbol: '⚡️🪄', name: 'Spellpower', chain: 'Chia', assetId: 'eb2155a177b6060535dd8e72e98ddb0c77aea21fab53737de1c1ced3cb38e4c4' },
        { id: 'byc-chia', symbol: '💸', name: 'Bytecash', displayName: '$BYC', chain: 'Chia', assetId: 'ae1536f56760e471ad85ead45f00d680ff9cca73b8cc3407be778f1c0c606eac' },
        { id: 'love-chia', symbol: '❤️', name: 'Love', chain: 'Chia', assetId: '70010d83542594dd44314efbae75d82b3d9ae7d946921ed981a6cd08f0549e50' },
        { id: 'sprout-chia', symbol: '🌱', name: 'Sprout', chain: 'Chia', assetId: 'ab558b1b841365a24d1ff2264c55982e55664a8b6e45bc107446b7e667bb463b' },
        { id: 'pizza-chia', symbol: '🍕', name: 'Pizza', chain: 'Chia', assetId: 'dd37f678dda586fad9b1daeae1f7c5c137ffa6d947e1ed5c7b4f3c430da80638' }
    ],
    base: [
        { id: 'wxch-base', symbol: 'wXCH', name: 'Wrapped XCH', chain: 'Base', contract: '0x36be1d329444aef5d28df3662ec5b4f965cd93e9' },
        { id: 'caster-base', symbol: '✨❤️‍🔥🧙‍♂️', name: 'Caster', chain: 'Base', contract: '0x09Aa909Eea859f712f2Ae3dd1872671D2363f6f4' },
        { id: 'spellpower-base', symbol: '⚡️🪄', name: 'Spellpower', chain: 'Base', contract: '0x145F14b876051DC443dd18D5f8a7C48c5db75847' },
        { id: 'wiz-base', symbol: '🧙💸', name: 'Wizard Bucks', chain: 'Base', contract: '0x39916e508e389FBB4dDC3d1a38a5801f4eE253c7' },
        { id: 'love-base', symbol: '❤️', name: 'Love', chain: 'Base', contract: '0x817cAb331aaA4c24b4e32024FCa093AD40CBa208' },
        { id: 'sprout-base', symbol: '🌱', name: 'Sprout', chain: 'Base', contract: '0xd1b771CB462a4B0e4d56Bb68b4bF832994CC8820' },
        { id: 'pizza-base', symbol: '🍕', name: 'Pizza', chain: 'Base', contract: '0x84070f2c685b3d4B63c66f0B13fB83Fa6ccb4035' }
    ]
};

function getOrigin(req) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

async function safeFetch(url, timeout = 12000) {
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

async function blobApi() {
    try {
        const mod = await import('@vercel/blob');
        if (!mod || typeof mod.put !== 'function' || typeof mod.head !== 'function') return null;
        return mod;
    } catch {
        return null;
    }
}

async function loadBlobSnapshot() {
    const api = await blobApi();
    if (!api) return null;
    try {
        const info = await api.head(INDEX_KEY);
        if (!info?.url) return null;
        const response = await safeFetch(info.url, 8000);
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

async function saveBlobSnapshot(snapshot) {
    const api = await blobApi();
    if (!api) return;
    try {
        await api.put(INDEX_KEY, JSON.stringify(snapshot), {
            access: 'public',
            contentType: 'application/json',
            addRandomSuffix: false,
            allowOverwrite: true
        });
    } catch (e) {
        console.warn('[market-index] Blob write failed:', e.message);
    }
}

async function fetchBestBaseToken(contract) {
    try {
        const response = await safeFetch(`https://api.dexscreener.com/latest/dex/tokens/${contract.toLowerCase()}`, 12000);
        if (response.ok) {
            const data = await response.json();
            const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
            const valid = pairs.filter(p => {
                if ((p.chainId || '').toLowerCase() !== 'base') return false;
                const quote = (p.quoteToken?.symbol || '').toUpperCase();
                return quote === 'WETH' || quote === 'USDC' || quote === 'ETH' || quote === 'USDT';
            });
            const best = valid.sort((a, b) => parseFloat(b.volume?.h24 || 0) - parseFloat(a.volume?.h24 || 0))[0];
            if (best) {
                const price = parseFloat(best.priceUsd || 0);
                const marketCap = parseFloat(best.marketCap || best.fdv || 0);
                if (price > 0) {
                    return {
                        price,
                        change24h: parseFloat(best.priceChange?.h24 || 0),
                        marketCap
                    };
                }
            }
        }
    } catch {}

    // GeckoTerminal fallback
    try {
        const gt = await safeFetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${contract.toLowerCase()}`, 12000);
        if (!gt.ok) return { price: 0, change24h: 0, marketCap: 0 };
        const data = await gt.json();
        const attr = data?.data?.attributes || {};
        const price = parseFloat(attr.price_usd || 0);
        const marketCap = parseFloat(attr.market_cap_usd || attr.fdv_usd || 0);
        if (price > 0) {
            return {
                price,
                change24h: 0,
                marketCap
            };
        }
    } catch {}

    return { price: 0, change24h: 0, marketCap: 0 };
    }
}

async function buildSnapshot(req) {
    const origin = getOrigin(req);

    const [coingeckoResponse, catResponse, baseRows] = await Promise.all([
        safeFetch(`${origin}/api/coingecko-proxy?ids=chia&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&t=${Date.now()}`, 12000)
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({})),
        safeFetch(`${origin}/api/chia-cat-prices?t=${Date.now()}`, 20000)
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({})),
        Promise.all(TRACKED.base.map(async t => ({ token: t, data: await fetchBestBaseToken(t.contract) })))
    ]);

    const xchPrice = parseFloat(coingeckoResponse?.chia?.usd || 0);
    const xchChange = parseFloat(coingeckoResponse?.chia?.usd_24h_change || 0);
    const xchMcap = parseFloat(coingeckoResponse?.chia?.usd_market_cap || 0);

    const prices = catResponse?.prices || {};
    const changes = catResponse?.changes || {};
    const mcaps = catResponse?.mcaps || {};

    const chia = TRACKED.chia.map(token => {
        if (token.assetId === 'Native') {
            return {
                ...token,
                price: xchPrice,
                change24h: xchChange,
                marketCap: xchMcap
            };
        }
        return {
            ...token,
            price: parseFloat(prices[token.assetId] || 0),
            change24h: parseFloat(changes[token.assetId] || 0),
            marketCap: parseFloat(mcaps[token.assetId] || 0)
        };
    });

    const base = baseRows.map(({ token, data }) => ({
        ...token,
        price: data.price,
        change24h: data.change24h,
        marketCap: data.marketCap
    }));

    return {
        savedAt: Date.now(),
        version: 1,
        base,
        chia
    };
}

export default async function handler(req, res) {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const force = req.query?.refresh === '1';

        if (!force && _memSnapshot && (Date.now() - _memAt < MEM_TTL_MS)) {
            return res.status(200).json({ ..._memSnapshot, source: 'memory' });
        }

        if (!force) {
            const blobSnap = await loadBlobSnapshot();
            if (blobSnap?.savedAt) {
                _memSnapshot = blobSnap;
                _memAt = Date.now();
                const blobAge = Date.now() - blobSnap.savedAt;
                if (blobAge > BLOB_TTL_MS && !_inflight) {
                    console.log(`[market-index] Blob stale (${Math.round(blobAge/60000)}m old) — SWR background rebuild`);
                    _inflight = buildSnapshot(req)
                        .then(async snap => { _memSnapshot = snap; _memAt = Date.now(); await saveBlobSnapshot(snap); return snap; })
                        .finally(() => { _inflight = null; });
                    return res.status(200).json({ ...blobSnap, source: 'blob-stale' });
                }
                return res.status(200).json({ ...blobSnap, source: 'blob' });
            }
        }

        if (!_inflight || force) {
            _inflight = buildSnapshot(req)
                .then(async (snapshot) => {
                    _memSnapshot = snapshot;
                    _memAt = Date.now();
                    await saveBlobSnapshot(snapshot);
                    return snapshot;
                })
                .finally(() => {
                    _inflight = null;
                });
        }

        const snapshot = await _inflight;
        return res.status(200).json({ ...snapshot, source: 'fresh' });
    } catch (e) {
        const fallback = _memSnapshot;
        if (fallback) return res.status(200).json({ ...fallback, source: 'memory-stale', error: String(e?.message || e) });
        return res.status(500).json({ error: 'market index failed', detail: String(e?.message || e) });
    }
}
