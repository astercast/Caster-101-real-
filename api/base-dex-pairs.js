/**
 * Pick best DexScreener pair per token on Base — any quote (USDC, WETH, ecosystem CATs, etc.).
 * Uses deepest liquidity pool; supports token as base or quote side of the pair.
 */

const MIN_LIQ_USD = 50;

export function pairLiquidityUsd(pair) {
    const liq = parseFloat(pair?.liquidity?.usd || 0);
    if (liq > 0) return liq;
    const vol = parseFloat(pair?.volume?.h24 || 0);
    return vol > 0 ? vol * 0.15 : 0;
}

/** USD price for `contract` from a single DexScreener pair (base or quote side). */
export function tokenUsdFromPair(pair, contract) {
    const target = String(contract || '').toLowerCase();
    if (!target) return 0;

    const baseAddr = (pair?.baseToken?.address || '').toLowerCase();
    const quoteAddr = (pair?.quoteToken?.address || '').toLowerCase();
    const priceUsd = parseFloat(pair?.priceUsd || 0);
    const priceNative = parseFloat(pair?.priceNative || 0);

    // Base side: priceUsd is this token's USD price (any quote: USDC, WETH, wXCH, ecosystem CATs).
    if (baseAddr === target) return priceUsd > 0 ? priceUsd : 0;

    if (quoteAddr !== target || priceUsd <= 0) return 0;

    // Quote side: derive USD from base token price and exchange rate (token-token pairs included).
    if (priceNative > 0) return priceUsd / priceNative;

    // Fallback when priceNative missing: spot from pool reserves (same math as priceUsd/priceNative).
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

/** DexScreener fdv/marketCap when this token is the pair base (quote-side mcap not reliable). */
export function tokenDexMcapFromPair(pair, contract) {
    const target = String(contract || '').toLowerCase();
    const baseAddr = (pair?.baseToken?.address || '').toLowerCase();
    if (baseAddr !== target) return 0;
    return parseFloat(pair?.marketCap || pair?.fdv || 0) || 0;
}

/**
 * Merge pairs into `out` map: contract (lowercase) → { price, change24h, liq, dexMcap, impliedSupply }.
 * Price from deepest-liquidity pool; dexMcap/impliedSupply from ANY pool where token is base (ecosystem pairs).
 */
export function mergeBasePairsIntoMap(pairs, contractSet, out = {}) {
    const wanted = contractSet instanceof Set
        ? contractSet
        : new Set((contractSet || []).map(c => String(c).toLowerCase()).filter(Boolean));

    const list = Array.isArray(pairs) ? pairs : (pairs?.pairs || []);

    for (const p of list) {
        if ((p?.chainId || '').toLowerCase() !== 'base') continue;
        const liq = pairLiquidityUsd(p);
        if (liq < MIN_LIQ_USD) continue;

        const baseAddr = (p.baseToken?.address || '').toLowerCase();
        const addrs = [
            baseAddr,
            (p.quoteToken?.address || '').toLowerCase()
        ];

        for (const ca of addrs) {
            if (!wanted.has(ca)) continue;
            const price = tokenUsdFromPair(p, ca);
            if (price <= 0) continue;

            const isBase = baseAddr === ca;
            const pairMcap = tokenDexMcapFromPair(p, ca);
            const pairImpliedSupply = isBase && pairMcap > 0 ? pairMcap / price : 0;

            const prev = out[ca] || {};
            const bestLiq = liq > (prev.liq || 0);

            out[ca] = {
                price: bestLiq ? price : (prev.price || price),
                change24h: bestLiq ? parseFloat(p?.priceChange?.h24 || 0) : (prev.change24h || 0),
                liq: Math.max(prev.liq || 0, liq),
                dexMcap: Math.max(prev.dexMcap || 0, pairMcap),
                impliedSupply: Math.max(prev.impliedSupply || 0, pairImpliedSupply)
            };
        }
    }

    return out;
}

/** Best single pair for one contract (legacy / per-token fetch). */
export function selectBestPairForContract(pairs, contract) {
    const ca = String(contract || '').toLowerCase();
    const map = mergeBasePairsIntoMap(pairs, new Set([ca]), {});
    return map[ca] || null;
}

/** GeckoTerminal relationship id → lowercase contract address. */
export function geckoAddrFromRelId(id) {
    return String(id || '').toLowerCase().replace(/^base_/, '');
}

/** GeckoTerminal quoted mcap/fdv when DexScreener has no pair for this token. */
export function parseGeckoTokenMcap(attr = {}) {
    return parseFloat(attr.market_cap_usd || attr.fdv_usd || 0) || 0;
}

/**
 * Price + supply + mcap hints from Gecko (all pools, including token↔token pairs DexScreener misses).
 * `peerPrices`: map of contract → USD price for other tracked tokens on Base.
 */
export function enrichBaseTokenFromGecko(attr = {}, pools = [], contract, peerPrices = {}) {
    const ca = String(contract || '').toLowerCase();
    let price = parseFloat(attr?.price_usd || 0);
    const gtSupply = parseGeckoTokenSupply(attr);
    const geckoMcap = parseGeckoTokenMcap(attr);

    if (price <= 0 && pools.length) {
        price = geckoTokenUsdFromPools(pools, contract);
    }

    for (const p of pools) {
        const a = p?.attributes || {};
        const baseId = String(p?.relationships?.base_token?.data?.id || '').toLowerCase();
        const quoteId = String(p?.relationships?.quote_token?.data?.id || '').toLowerCase();
        const basePx = parseFloat(a.base_token_price_usd || 0);
        const quotePx = parseFloat(a.quote_token_price_usd || 0);

        if (baseId.includes(ca) && quotePx > 0 && basePx > 0) {
            const peerPx = peerPrices[geckoAddrFromRelId(quoteId)];
            if (peerPx > 0) {
                const implied = peerPx * (basePx / quotePx);
                if (implied > 0) price = price > 0 ? (price + implied) / 2 : implied;
            }
        } else if (quoteId.includes(ca) && quotePx > 0 && basePx > 0) {
            const peerPx = peerPrices[geckoAddrFromRelId(baseId)];
            if (peerPx > 0) {
                const implied = peerPx * (quotePx / basePx);
                if (implied > 0) price = price > 0 ? (price + implied) / 2 : implied;
            }
        }
    }

    const impliedSupply = price > 0 && geckoMcap > 0 ? geckoMcap / price : 0;

    return { price, gtSupply, geckoMcap, impliedSupply };
}

/** GeckoTerminal token attributes → circulating supply (tokens, not raw units). */
export function parseGeckoTokenSupply(attr = {}) {
    const normalized = parseFloat(attr.normalized_total_supply || 0);
    if (normalized > 0) return normalized;

    const total = parseFloat(attr.total_supply || 0);
    if (total > 0) return total;

    const price = parseFloat(attr.price_usd || 0);
    const mcapUsd = parseFloat(attr.market_cap_usd || attr.fdv_usd || 0);
    if (mcapUsd > 0 && price > 0) return mcapUsd / price;

    return 0;
}

/**
 * Base market cap: reconcile Gecko supply, implied supply from ecosystem base-side pairs,
 * and DexScreener fdv (any pool where this token is base — not only USDC/WETH quotes).
 */
export function resolveBaseMarketCap({
    gtSupply = 0,
    price = 0,
    dexMcap = 0,
    impliedSupply = 0,
    geckoMcap = 0
} = {}) {
    if (!price || price <= 0) return 0;

    const geckoCalcMcap = gtSupply > 0 ? gtSupply * price : 0;
    const impliedMcap = impliedSupply > 0 ? impliedSupply * price : 0;
    const candidates = [
        { mcap: dexMcap, kind: 'dex' },
        { mcap: geckoMcap, kind: 'geckoQuote' },
        { mcap: impliedMcap, kind: 'implied' },
        { mcap: geckoCalcMcap, kind: 'geckoCalc' }
    ].filter(c => c.mcap > 0 && Number.isFinite(c.mcap));

    if (!candidates.length) return 0;
    if (candidates.length === 1) return candidates[0].mcap;

    const anchor = dexMcap > 0 ? dexMcap : (impliedMcap > 0 ? impliedMcap : 0);
    if (anchor > 0) {
        const inBand = candidates.filter(c => {
            const r = c.mcap / anchor;
            return r >= 0.25 && r <= 4;
        });
        if (inBand.length) {
            inBand.sort((a, b) => Math.abs(a.mcap - anchor) - Math.abs(b.mcap - anchor));
            return inBand[0].mcap;
        }
        return anchor;
    }

    return Math.min(...candidates.map(c => c.mcap));
}
