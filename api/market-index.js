// Simple pricing: DexScreener (standard quotes, volume-sorted) + GeckoTerminal fallback
// No import of base-dex-pairs.js — that module is only used by arbitrage.js

const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
};

const INDEX_KEY = 'caster101-index/market-v2.json';
const MEM_TTL_MS = 60 * 1000;         // in-memory hot cache: 1 min
const BLOB_TTL_MS = 10 * 60 * 1000;   // blob SWR threshold: 10 min — older → background rebuild

let _memSnapshot = null;
let _memAt = 0;
let _inflight = null;

// Standard quote tokens — only these are trusted for pricing
const STANDARD_QUOTES = new Set(['weth', 'usdc', 'eth', 'usdt', 'wxch', 'xch', 'usd coin', 'wrapped ether']);

const TRACKED = {
    chia: [
        { id: 'xch', symbol: 'XCH', name: 'Chia', chain: 'Chia', assetId: 'Native' },
        { id: 'caster-chia', symbol: '✨❤️‍🔥🧙‍♂️', name: 'Caster', chain: 'Chia', assetId: 'a09af8b0d12b27772c64f89cf0d1db95186dca5b1871babc5108ff44f36305e6' },
        { id: 'spellpower-chia', symbol: '⚡️🪄', name: 'Spellpower', chain: 'Chia', assetId: 'eb2155a177b6060535dd8e72e98ddb0c77aea21fab53737de1c1ced3cb38e4c4' },
        { id: 'byc-chia', symbol: '💸', name: 'Bytecash', displayName: '$BYC', chain: 'Chia', assetId: 'ae1536f56760e471ad85ead45f00d680ff9cca73b8cc3407be778f1c0c606eac' },
        { id: 'love-chia', symbol: '❤️', name: 'Love', chain: 'Chia', assetId: '70010d83542594dd44314efbae75d82b3d9ae7d946921ed981a6cd08f0549e50' },
        { id: 'sprout-chia', symbol: '🌱', name: 'Sprout', chain: 'Chia', assetId: 'ab558b1b841365a24d1ff2264c55982e55664a8b6e45bc107446b7e667bb463b' },
        { id: 'pizza-chia', symbol: '🍕', name: 'Pizza', chain: 'Chia', assetId: 'dd37f678dda586fad9b1daeae1f7c5c137ffa6d947e1ed5c7b4f3c430da80638' },
        { id: 'bepe-chia', symbol: '$BEPE', name: 'BEPE', chain: 'Chia', assetId: 'ccda69ff6c44d687994efdbee30689be51d2347f739287ab4bb7b52344f8bf1d' },
        { id: 'honk-chia', symbol: '🪿', name: 'HonK', displayName: '$HONK', chain: 'Chia', assetId: '048b1358f3b55a70c4db22114c2f52569c0398ba19e8212b8daf1cb25c90a641' },
        { id: 'neck-chia', symbol: '$NECK', name: 'NeckCoin', chain: 'Chia', assetId: '1ad673d21799c9a224014ca71f9fe07cbc836fa23fa97b3be275d46d0b8bd9da' },
        { id: 'chia-meme-chia', symbol: '$CHIA', name: 'VFVAPatek9000Inu', chain: 'Chia', assetId: '69326954fe16117cd6250e929748b2a1ab916347598bc8180749279cfae21ddb' },
        { id: 'hodl-chia', symbol: '💎', name: 'HODL', displayName: '$HODL', chain: 'Chia', assetId: 'e335003c6d59aaaabe27eeeaf8a7b1308765f6bc9492a0b16394f50dec6bdcb7' },
        { id: 'mana-chia', symbol: '🧙‍♂️', name: 'MANA', displayName: 'MANA', chain: 'Chia', assetId: '1653a1df583f3ae6a822ab214b74d2a08fb4309025d54f2db140e5e6bc06e9da' },
        { id: 'hoa-chia', symbol: '🍊', name: 'HOA', chain: 'Chia', assetId: 'e816ee18ce2337c4128449bc539fbbe2ecfdd2098c4e7cab4667e223c3bdc23d' },
        { id: 'ni-chia', symbol: '$NI', name: 'No Idea', chain: 'Chia', assetId: 'c0eb7cc73ef2e789a7b9cf7c8c27185beb2ff5fdf2997da28a6b9b3714e4034d' },
        { id: 'horse-chia', symbol: '$HORSE', name: 'HouseofRegardedSchizoEquestrians', displayName: '$HORSE', chain: 'Chia', assetId: '1efff18fedcdb63818a1b41ab3e977707bc314a090e7ea5db396a56095290604' },
        { id: 'tigerblood-chia', symbol: '🐯🩸', name: 'Tiger Blood', chain: 'Chia', assetId: '95430751e3894b48820b7da497f04abd0e46fe6d982fa98daf174ff1e35159bd' },
        { id: 'chocotaco-chia', symbol: '🍫🌮', name: 'Choco Taco', chain: 'Chia', assetId: '8df67763ad273f4a08f8f19f8a172d80b38ad940f32fe20b0b2ed3d665edf575' }
    ],
    base: [
        { id: 'wxch-base', symbol: 'wXCH', name: 'Wrapped XCH', chain: 'Base', contract: '0x36be1d329444aef5d28df3662ec5b4f965cd93e9' },
        { id: 'caster-base', symbol: '✨❤️‍🔥🧙‍♂️', name: 'Caster', chain: 'Base', contract: '0x09Aa909Eea859f712f2Ae3dd1872671D2363f6f4' },
        { id: 'spellpower-base', symbol: '⚡️🪄', name: 'Spellpower', chain: 'Base', contract: '0x145F14b876051DC443dd18D5f8a7C48c5db75847' },
        { id: 'wiz-base', symbol: '🧙💸', name: 'Wizard Bucks', chain: 'Base', contract: '0x39916e508e389FBB4dDC3d1a38a5801f4eE253c7' },
        { id: 'love-base', symbol: '❤️', name: 'Love', chain: 'Base', contract: '0x817cAb331aaA4c24b4e32024FCa093AD40CBa208' },
        { id: 'sprout-base', symbol: '🌱', name: 'Sprout', chain: 'Base', contract: '0xd1b771CB462a4B0e4d56Bb68b4bF832994CC8820' },
        { id: 'pizza-base', symbol: '🍕', name: 'Pizza', chain: 'Base', contract: '0x84070f2c685b3d4B63c66f0B13fB83Fa6ccb4035' },
        { id: 'bepe-base', symbol: '$BEPE', name: 'BEPE', chain: 'Base', contract: '0xBB5cBDAE23C5368557CC9A32337863eECf03cF9f' },
        { id: 'honk-base', symbol: '🪿', name: 'HonK', displayName: '$HONK', chain: 'Base', contract: '0xF6C04947A13481daAf4E8756B04f3D6bB7C30efF' },
        { id: 'neck-base', symbol: '$NECK', name: 'NeckCoin', chain: 'Base', contract: '0x359D5BFa1bb87598e2198EC139eE44D31Bd06FaC' },
        { id: 'chia-meme-base', symbol: '$CHIA', name: 'VFVAPatek9000Inu', chain: 'Base', contract: '0x05AefaFfF978EA4F9E6ff9FA3Bc2465B90598549' },
        { id: 'hodl-base', symbol: '💎', name: 'HODL', displayName: '$HODL', chain: 'Base', contract: '0xb43ba3fD8ac8b16ED52CFBE72738967C2AD9cC03' },
        { id: 'mana-base', symbol: '🧙‍♂️', name: 'MANA', displayName: 'MANA', chain: 'Base', contract: '0x4cE68125983527D1e289a0C1c70464B4bb8932ac' },
        { id: 'hoa-base', symbol: '🍊', name: 'HOA', chain: 'Base', contract: '0xee642384091f4bb9ab457b875E4e209b5a0BD147' },
        { id: 'ni-base', symbol: '$NI', name: 'No Idea', chain: 'Base', contract: '0xf628fD48BB4A4903DdCdBb89b814B5484456fc4E' },
        { id: 'horse-base', symbol: '$HORSE', name: 'HouseofRegardedSchizoEquestrians', displayName: '$HORSE', chain: 'Base', contract: '0x827fc57Bc514578E8280cEE73f5e948D306aF074' },
        { id: 'tigerblood-base', symbol: '🐯🩸', name: 'Tiger Blood', chain: 'Base', contract: '0xD999c5E89018a28deA05607837DD5DD6de26d907' },
        { id: 'chocotaco-base', symbol: '🍫🌮', name: 'Choco Taco', chain: 'Base', contract: '0xBaB8a1AD71710d62e7E4c2F56c299422C6187c38' }
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

/** Is this a standard quote token? (WETH, USDC, ETH, USDT, wXCH, XCH) */
function isStandardQuote(pair) {
    const sym = (pair?.quoteToken?.symbol || '').toLowerCase();
    const name = (pair?.quoteToken?.name || '').toLowerCase();
    return STANDARD_QUOTES.has(sym) || STANDARD_QUOTES.has(name);
}

/**
 * Old-style per-token pricing: DexScreener standard-quote pairs (volume-sorted)
 * + GeckoTerminal fallback for price/mcap.
 */
async function fetchBestBaseToken(contract) {
    const ca = contract.toLowerCase();
    let price = 0, change24h = 0, marketCap = 0;

    // ── DexScreener: filter to standard quotes, sort by volume ──
    try {
        const response = await safeFetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, 12000);
        if (response.ok) {
            const data = await response.json();
            const pairs = (data?.pairs || [])
                .filter(p => (p.chainId || '').toLowerCase() === 'base' && isStandardQuote(p))
                .sort((a, b) => parseFloat(b?.volume?.h24 || 0) - parseFloat(a?.volume?.h24 || 0));

            if (pairs.length > 0) {
                const best = pairs[0];
                price = parseFloat(best.priceUsd || 0);
                change24h = parseFloat(best.priceChange?.h24 || 0);
                marketCap = parseFloat(best.marketCap || best.fdv || 0);
            }
        }
    } catch {}

    // ── GeckoTerminal fallback: price + mcap if DexScreener missed ──
    if (price <= 0 || marketCap <= 0) {
        try {
            const gt = await safeFetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${ca}`, 12000);
            if (gt.ok) {
                const attr = (await gt.json())?.data?.attributes || {};
                const gtPrice = parseFloat(attr.price_usd || 0);
                const gtMcap = parseFloat(attr.market_cap_usd || attr.fdv_usd || 0);
                const normalizedSupply = parseFloat(attr.normalized_total_supply || 0);

                if (price <= 0 && gtPrice > 0) price = gtPrice;

                if (marketCap <= 0) {
                    if (gtMcap > 0) {
                        marketCap = gtMcap;
                    } else if (normalizedSupply > 0 && price > 0) {
                        marketCap = normalizedSupply * price;
                    }
                }

                // If still no price, try pools
                if (price <= 0) {
                    const poolsRes = await safeFetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${ca}/pools`, 12000);
                    if (poolsRes.ok) {
                        const poolsData = await poolsRes.json();
                        const pools = Array.isArray(poolsData?.data) ? poolsData.data : [];
                        for (const p of pools) {
                            const pAttr = p?.attributes || {};
                            const baseId = String(p?.relationships?.base_token?.data?.id || '').toLowerCase();
                            if (baseId.includes(ca)) {
                                const bp = parseFloat(pAttr.base_token_price_usd || 0);
                                if (bp > 0) { price = bp; break; }
                            }
                            const quoteId = String(p?.relationships?.quote_token?.data?.id || '').toLowerCase();
                            if (quoteId.includes(ca)) {
                                const qp = parseFloat(pAttr.quote_token_price_usd || 0);
                                if (qp > 0) { price = qp; break; }
                            }
                        }
                        // Derive mcap from supply if needed
                        if (marketCap <= 0 && normalizedSupply > 0 && price > 0) {
                            marketCap = normalizedSupply * price;
                        }
                    }
                }
            }
        } catch {}
    }

    return { price, change24h, marketCap };
}

/** Fetch all Base tokens: batch DexScreener first for speed, then per-token fallback. */
async function fetchAllBaseTokens(tokens) {
    const contracts = tokens.map(t => String(t.contract || '').toLowerCase()).filter(Boolean);
    const results = {};

    // ── Batch DexScreener: get all pairs in one call, filter to standard quotes ──
    try {
        const response = await safeFetch(
            `https://api.dexscreener.com/tokens/v1/base/${contracts.join(',')}`,
            15000
        );
        if (response.ok) {
            const data = await response.json();
            const allPairs = Array.isArray(data) ? data : (data?.pairs || []);

            for (const ca of contracts) {
                const pairs = allPairs
                    .filter(p =>
                        (p.chainId || '').toLowerCase() === 'base' &&
                        isStandardQuote(p) &&
                        (p.baseToken?.address || '').toLowerCase() === ca
                    )
                    .sort((a, b) => parseFloat(b?.volume?.h24 || 0) - parseFloat(a?.volume?.h24 || 0));

                if (pairs.length > 0) {
                    const best = pairs[0];
                    results[ca] = {
                        price: parseFloat(best.priceUsd || 0),
                        change24h: parseFloat(best.priceChange?.h24 || 0),
                        marketCap: parseFloat(best.marketCap || best.fdv || 0)
                    };
                }
            }
        }
    } catch {}

    // ── Per-token fallback for tokens that batch missed ──
    const missed = tokens.filter(t => {
        const d = results[t.contract.toLowerCase()];
        return !d || d.price <= 0;
    });

    for (const t of missed) {
        const data = await fetchBestBaseToken(t.contract);
        results[t.contract.toLowerCase()] = data;
    }

    // ── GeckoTerminal batch for mcap fallback (tokens with price but no mcap) ──
    const needMcap = tokens.filter(t => {
        const d = results[t.contract.toLowerCase()];
        return d && d.price > 0 && (!d.marketCap || d.marketCap <= 0);
    });

    if (needMcap.length > 0) {
        try {
            const mcapContracts = needMcap.map(t => t.contract.toLowerCase()).join(',');
            const batchRes = await safeFetch(
                `https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/${mcapContracts}`,
                15000
            );
            if (batchRes.ok) {
                const batchData = await batchRes.json();
                for (const item of (batchData?.data || [])) {
                    const attrs = item?.attributes || {};
                    const addr = String(attrs?.address || '').toLowerCase();
                    if (!addr || !results[addr]) continue;
                    const d = results[addr];
                    if (d.marketCap > 0) continue;
                    const gtMcap = parseFloat(attrs.market_cap_usd || attrs.fdv_usd || 0);
                    const supply = parseFloat(attrs.normalized_total_supply || 0);
                    if (gtMcap > 0) {
                        d.marketCap = gtMcap;
                    } else if (supply > 0 && d.price > 0) {
                        d.marketCap = supply * d.price;
                    }
                }
            }
        } catch {}
    }

    return tokens.map(token => ({
        token,
        data: results[token.contract.toLowerCase()] || { price: 0, change24h: 0, marketCap: 0 }
    }));
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
        fetchAllBaseTokens(TRACKED.base)
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
        const price = parseFloat(prices[token.assetId] || 0);
        const marketCap = parseFloat(mcaps[token.assetId] || 0);
        return {
            ...token,
            price,
            change24h: parseFloat(changes[token.assetId] || 0),
            marketCap
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

    // ── POST: browser pushes its fresh snapshot so next visitor gets it instantly ──
    if (req.method === 'POST') {
        try {
            const body = req.body || {};
            const base = body.base || [];
            const chia = body.chia || [];
            // Require at least one priced chia CAT (not XCH-only)
            const hasPricedChia = chia.some(t => t.assetId !== 'Native' && t.price > 0);
            if (!hasPricedChia || base.length === 0) {
                return res.status(400).json({ ok: false, reason: 'insufficient data' });
            }
            const snapshot = { base, chia, savedAt: Date.now() };
            _memSnapshot = snapshot;
            _memAt = Date.now();
            await saveBlobSnapshot(snapshot);
            console.log(`[market-index] Browser snapshot saved: ${base.length} base + ${chia.length} chia`);
            return res.status(200).json({ ok: true });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    }

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
