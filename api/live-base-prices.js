/**
 * Live Base USD prices — same pipeline as market-index (Dex full pairs + Gecko gaps).
 */
import {
    enrichBaseTokenFromGecko,
    mergeBasePairsIntoMap,
    mergeGeckoIntoDexRow
} from './base-dex-pairs.js';

async function safeFetch(url, timeout = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json' }
        });
        clearTimeout(timer);
        return response;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

async function fetchGeckoTokenAttrs(contracts) {
    try {
        const url = `https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/${contracts.join(',')}`;
        const gt = await safeFetch(url, 15000);
        if (!gt.ok) return {};
        const data = (await gt.json())?.data || [];
        const map = {};
        for (const token of data) {
            const addr = (token?.attributes?.address || '').toLowerCase();
            if (addr) map[addr] = token.attributes;
        }
        return map;
    } catch {
        return {};
    }
}

async function fetchGeckoPools(contract) {
    const ca = contract.toLowerCase();
    try {
        const poolsRes = await safeFetch(
            `https://api.geckoterminal.com/api/v2/networks/base/tokens/${ca}/pools`,
            12000
        );
        if (!poolsRes.ok) return [];
        const poolsData = await poolsRes.json();
        return Array.isArray(poolsData?.data) ? poolsData.data : [];
    } catch {
        return [];
    }
}

function buildPeerPrices(dexMap) {
    const peerPrices = {};
    for (const [addr, row] of Object.entries(dexMap)) {
        if (row?.price > 0) peerPrices[addr] = row.price;
    }
    return peerPrices;
}

/**
 * @param {Array<{ contract: string }>} tokens
 * @returns {Promise<Record<string, { price: number, change24h: number }>>}
 */
export async function fetchLiveBasePriceMap(tokens) {
    const contracts = tokens.map(t => String(t.contract || '').toLowerCase()).filter(Boolean);
    const contractSet = new Set(contracts);
    const dexMap = {};

    try {
        const response = await safeFetch(
            `https://api.dexscreener.com/tokens/v1/base/${contracts.join(',')}`,
            15000
        );
        if (response.ok) {
            const data = await response.json();
            const pairs = Array.isArray(data) ? data : (data?.pairs || []);
            mergeBasePairsIntoMap(pairs, contractSet, dexMap);
        }
    } catch {}

    for (const token of tokens) {
        try {
            const response = await safeFetch(
                `https://api.dexscreener.com/latest/dex/tokens/${token.contract.toLowerCase()}`,
                12000
            );
            if (response.ok) {
                const data = await response.json();
                mergeBasePairsIntoMap(data?.pairs || [], contractSet, dexMap);
            }
        } catch {}
        await new Promise(res => setTimeout(res, 80));
    }

    const geckoAttrs = await fetchGeckoTokenAttrs(contracts);
    let peerPrices = buildPeerPrices(dexMap);

    for (const token of tokens) {
        const ca = token.contract.toLowerCase();
        const dex = dexMap[ca] || {};
        const meta = enrichBaseTokenFromGecko(
            geckoAttrs[ca] || {},
            [],
            token.contract,
            peerPrices,
            dex.price > 0
        );
        dexMap[ca] = mergeGeckoIntoDexRow(dex, meta);
    }

    const needsPools = tokens.filter(t => !dexMap[t.contract.toLowerCase()]?.price);
    peerPrices = buildPeerPrices(dexMap);
    for (const token of needsPools) {
        const ca = token.contract.toLowerCase();
        const pools = await fetchGeckoPools(token.contract);
        const meta = enrichBaseTokenFromGecko(
            geckoAttrs[ca] || {},
            pools,
            token.contract,
            peerPrices,
            false
        );
        dexMap[ca] = mergeGeckoIntoDexRow(dexMap[ca] || {}, meta);
        if (dexMap[ca]?.price > 0) peerPrices[ca] = dexMap[ca].price;
        await new Promise(res => setTimeout(res, 120));
    }

    const out = {};
    for (const ca of contracts) {
        const row = dexMap[ca];
        if (row?.price > 0) {
            out[ca] = {
                price: row.price,
                change24h: parseFloat(row.change24h || 0)
            };
        }
    }
    return out;
}
