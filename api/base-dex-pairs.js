/**
 * Base DEX pricing — DexScreener (all pair sides) + GeckoTerminal fallback for gaps only.
 */

const MIN_LIQ_USD = 50;

/** Quote tokens treated as reliable USD anchors for price selection. */
const STABLE_QUOTE_HINTS = new Set([
    'usdc', 'usdt', 'dai', 'usd', 'usdbc', 'weth', 'eth', 'cbeth', 'wxch'
]);

export function pairLiquidityUsd(pair) {
    const liq = parseFloat(pair?.liquidity?.usd || 0);
    if (liq > 0) return liq;
    const vol = parseFloat(pair?.volume?.h24 || 0);
    return vol > 0 ? vol * 0.15 : 0;
}

function normalizeSymbol(sym) {
    return String(sym || '').toLowerCase().replace(/^\$/, '').replace(/^w/, '');
}

export function isAnchorQuoteSymbol(symbol) {
    const s = normalizeSymbol(symbol);
    return STABLE_QUOTE_HINTS.has(s) || s.includes('usdc') || s === 'usdc';
}

/** Score pool for price selection — prefer deep liquidity + USD-anchored quotes. */
export function pairPriceScore(pair, contract) {
    const target = String(contract || '').toLowerCase();
    const baseAddr = (pair?.baseToken?.address || '').toLowerCase();
    const quoteAddr = (pair?.quoteToken?.address || '').toLowerCase();
    const liq = pairLiquidityUsd(pair);
    if (liq < MIN_LIQ_USD) return 0;

    let score = liq;
    if (baseAddr === target && isAnchorQuoteSymbol(pair?.quoteToken?.symbol)) score += 8000;
    if (quoteAddr === target && isAnchorQuoteSymbol(pair?.baseToken?.symbol)) score += 8000;

    return score;
}

/** USD price for `contract` from a single DexScreener pair (base or quote side). */
export function tokenUsdFromPair(pair, contract) {
    const target = String(contract || '').toLowerCase();
    if (!target) return 0;

    const baseAddr = (pair?.baseToken?.address || '').toLowerCase();
    const quoteAddr = (pair?.quoteToken?.address || '').toLowerCase();
    const priceUsd = parseFloat(pair?.priceUsd || 0);
    const priceNative = parseFloat(pair?.priceNative || 0);

    if (baseAddr === target) return priceUsd > 0 ? priceUsd : 0;

    if (quoteAddr !== target || priceUsd <= 0) return 0;
    if (priceNative > 0) return priceUsd / priceNative;

    const baseRes = parseFloat(pair?.liquidity?.base || 0);
    const quoteRes = parseFloat(pair?.liquidity?.quote || 0);
    if (baseRes > 0 && quoteRes > 0) return (baseRes * priceUsd) / quoteRes;

    return 0;
}

/** Best USD price for `contract` from GeckoTerminal pool list (base or quote side). */
export function geckoTokenUsdFromPools(pools, contract) {
    const ca = String(contract || '').toLowerCase();
    let bestPrice = 0;
    let bestRes = 0;

    for (const p of (pools || [])) {
        const attr = p?.attributes || {};
        const res = parseFloat(attr.reserve_in_usd || 0);
        const baseId = String(p?.relationships?.base_token?.data?.id || '').toLowerCase();
        const quoteId = String(p?.relationships?.quote_token?.data?.id || '').toLowerCase();

        let price = 0;
        if (baseId.includes(ca)) price = parseFloat(attr.base_token_price_usd || 0);
        else if (quoteId.includes(ca)) price = parseFloat(attr.quote_token_price_usd || 0);

        if (price > 0 && res >= bestRes) {
            bestRes = res;
            bestPrice = price;
        }
    }

    return bestPrice;
}

export function tokenDexMcapFromPair(pair, contract) {
    const target = String(contract || '').toLowerCase();
    const baseAddr = (pair?.baseToken?.address || '').toLowerCase();
    if (baseAddr !== target) return 0;
    return parseFloat(pair?.marketCap || pair?.fdv || 0) || 0;
}

/**
 * Merge DexScreener pairs → { price, change24h, liq, dexMcap, impliedSupply }.
 * Price from best-scored pool; dexMcap = max fdv across pools where token is base.
 */
export function mergeBasePairsIntoMap(pairs, contractSet, out = {}) {
    const wanted = contractSet instanceof Set
        ? contractSet
        : new Set((contractSet || []).map(c => String(c).toLowerCase()).filter(Boolean));

    const list = Array.isArray(pairs) ? pairs : (pairs?.pairs || []);

    for (const p of list) {
        if ((p?.chainId || '').toLowerCase() !== 'base') continue;

        const baseAddr = (p.baseToken?.address || '').toLowerCase();
        const quoteAddr = (p.quoteToken?.address || '').toLowerCase();
        const addrs = [baseAddr, quoteAddr];

        for (const ca of addrs) {
            if (!wanted.has(ca)) continue;

            const price = tokenUsdFromPair(p, ca);
            if (price <= 0) continue;

            const score = pairPriceScore(p, ca);
            const isBase = baseAddr === ca;
            const pairMcap = tokenDexMcapFromPair(p, ca);
            const pairImpliedSupply = isBase && pairMcap > 0 ? pairMcap / price : 0;

            const prev = out[ca] || {};
            const bestScore = score > (prev.priceScore || 0);

            out[ca] = {
                price: bestScore ? price : (prev.price || price),
                priceScore: Math.max(prev.priceScore || 0, score),
                change24h: bestScore ? parseFloat(p?.priceChange?.h24 || 0) : (prev.change24h || 0),
                liq: Math.max(prev.liq || 0, pairLiquidityUsd(p)),
                dexMcap: Math.max(prev.dexMcap || 0, pairMcap),
                impliedSupply: Math.max(prev.impliedSupply || 0, pairImpliedSupply),
                gtSupply: prev.gtSupply || 0,
                geckoMcap: prev.geckoMcap || 0
            };
        }
    }

    return out;
}

export function selectBestPairForContract(pairs, contract) {
    const ca = String(contract || '').toLowerCase();
    const map = mergeBasePairsIntoMap(pairs, new Set([ca]), {});
    return map[ca] || null;
}

export function geckoAddrFromRelId(id) {
    return String(id || '').toLowerCase().replace(/^base_/, '');
}

export function parseGeckoTokenMcap(attr = {}) {
    return parseFloat(attr.market_cap_usd || attr.fdv_usd || 0) || 0;
}

export function parseGeckoTokenSupply(attr = {}) {
    const normalized = parseFloat(attr.normalized_total_supply || 0);
    if (normalized > 0 && normalized < 1e15) return normalized;

    const rawTotal = parseFloat(attr.total_supply || 0);
    const decimals = parseInt(attr.decimals || 0, 10);
    if (rawTotal > 0 && decimals > 0) {
        const supply = rawTotal / Math.pow(10, decimals);
        if (supply > 0 && supply < 1e15) return supply;
    }

    const price = parseFloat(attr.price_usd || 0);
    const mcapUsd = parseGeckoTokenMcap(attr);
    if (mcapUsd > 0 && price > 0) {
        const supply = mcapUsd / price;
        if (supply > 0 && supply < 1e15) return supply;
    }

    return 0;
}

/** Drop absurd Gecko supplies (raw units mistaken for circulating). */
export function sanitizeGtSupply(gtSupply, price, anchorMcap = 0) {
    const supply = parseFloat(gtSupply || 0);
    const px = parseFloat(price || 0);
    if (supply <= 0 || px <= 0) return 0;
    if (supply > 1e12) return 0;

    const calc = supply * px;
    const anchor = parseFloat(anchorMcap || 0);
    if (anchor > 0) {
        const ratio = calc / anchor;
        if (ratio < 0.2 || ratio > 5) return 0;
    }

    return supply;
}

/**
 * Gecko enrichment — only fills gaps when Dex has no price.
 * `dexHasPrice`: if true, only fetch supply/mcap hints, never override Dex price.
 */
export function enrichBaseTokenFromGecko(attr = {}, pools = [], contract, peerPrices = {}, dexHasPrice = false) {
    const ca = String(contract || '').toLowerCase();
    const geckoMcap = parseGeckoTokenMcap(attr);
    const gtSupplyRaw = parseGeckoTokenSupply(attr);
    const anchorMcap = geckoMcap;

    let price = 0;
    if (!dexHasPrice) {
        price = parseFloat(attr?.price_usd || 0);
        if (price <= 0 && pools.length) {
            price = geckoTokenUsdFromPools(pools, contract);
        }

        // Last resort: derive from a tracked peer in a shared pool
        if (price <= 0 && pools.length && peerPrices) {
            for (const p of pools) {
                const a = p?.attributes || {};
                const baseId = String(p?.relationships?.base_token?.data?.id || '').toLowerCase();
                const quoteId = String(p?.relationships?.quote_token?.data?.id || '').toLowerCase();
                const basePx = parseFloat(a.base_token_price_usd || 0);
                const quotePx = parseFloat(a.quote_token_price_usd || 0);

                if (baseId.includes(ca) && quotePx > 0 && basePx > 0) {
                    const peerPx = peerPrices[geckoAddrFromRelId(quoteId)];
                    if (peerPx > 0) { price = peerPx * (basePx / quotePx); break; }
                } else if (quoteId.includes(ca) && quotePx > 0 && basePx > 0) {
                    const peerPx = peerPrices[geckoAddrFromRelId(baseId)];
                    if (peerPx > 0) { price = peerPx * (quotePx / basePx); break; }
                }
            }
        }
    }

    const gtSupply = sanitizeGtSupply(gtSupplyRaw, price || parseFloat(attr?.price_usd || 0), anchorMcap);
    const impliedSupply = price > 0 && geckoMcap > 0 ? geckoMcap / price : 0;

    return { price, gtSupply, geckoMcap, impliedSupply };
}

/** Merge Gecko hints into Dex row — never override a Dex price. */
export function mergeGeckoIntoDexRow(dex = {}, meta = {}) {
    const price = dex.price > 0 ? dex.price : (meta.price || 0);
    const anchor = Math.max(dex.dexMcap || 0, meta.geckoMcap || 0);
    const gtSupply = sanitizeGtSupply(
        meta.gtSupply > 0 ? meta.gtSupply : (dex.gtSupply || 0),
        price,
        anchor
    );

    return {
        price,
        change24h: dex.change24h || 0,
        liq: dex.liq || 0,
        dexMcap: dex.dexMcap || 0,
        geckoMcap: meta.geckoMcap || 0,
        impliedSupply: Math.max(dex.impliedSupply || 0, meta.impliedSupply || 0),
        gtSupply
    };
}

/**
 * Base market cap priority:
 * 1) DexScreener fdv (max across pools, token as base)
 * 2) Gecko quoted fdv/mcap
 * 3) implied supply × price (Dex pool fdv / price)
 * 4) sanitized Gecko supply × price
 */
export function resolveBaseMarketCap({
    gtSupply = 0,
    price = 0,
    dexMcap = 0,
    impliedSupply = 0,
    geckoMcap = 0
} = {}) {
    if (!price || price <= 0) return 0;

    const dex = parseFloat(dexMcap || 0);
    if (dex > 0) return dex;

    const gecko = parseFloat(geckoMcap || 0);
    if (gecko > 0) return gecko;

    const implied = impliedSupply > 0 ? impliedSupply * price : 0;
    if (implied > 0) return implied;

    const supply = sanitizeGtSupply(gtSupply, price, gecko);
    if (supply > 0) return supply * price;

    return 0;
}
