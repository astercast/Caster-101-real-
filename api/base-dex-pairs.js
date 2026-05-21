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

    if (baseAddr === target) return priceUsd > 0 ? priceUsd : 0;
    if (quoteAddr === target && priceUsd > 0 && priceNative > 0) {
        return priceUsd / priceNative;
    }
    return 0;
}

/** DexScreener fdv/marketCap when this token is the pair base (quote-side mcap not reliable). */
export function tokenDexMcapFromPair(pair, contract) {
    const target = String(contract || '').toLowerCase();
    const baseAddr = (pair?.baseToken?.address || '').toLowerCase();
    if (baseAddr !== target) return 0;
    return parseFloat(pair?.marketCap || pair?.fdv || 0) || 0;
}

/**
 * Merge pairs into `out` map: contract (lowercase) → { price, change24h, liq, dexMcap }.
 * Keeps the highest-liquidity pool per contract.
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

        const addrs = [
            (p.baseToken?.address || '').toLowerCase(),
            (p.quoteToken?.address || '').toLowerCase()
        ];

        for (const ca of addrs) {
            if (!wanted.has(ca)) continue;
            const price = tokenUsdFromPair(p, ca);
            if (price <= 0) continue;

            const prev = out[ca];
            if (prev && (prev.liq || 0) >= liq) continue;

            out[ca] = {
                price,
                change24h: parseFloat(p?.priceChange?.h24 || 0),
                liq,
                dexMcap: tokenDexMcapFromPair(p, ca)
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
 * Base market cap: prefer supply × price; fall back to DexScreener fdv only when
 * the token is the pair base (dexMcap set by mergeBasePairsIntoMap).
 */
export function resolveBaseMarketCap({ gtSupply = 0, price = 0, dexMcap = 0 } = {}) {
    if (!price || price <= 0) return 0;
    if (gtSupply > 0) return gtSupply * price;
    if (dexMcap > 0) return dexMcap;
    return 0;
}
