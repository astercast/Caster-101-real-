/**
 * Audit Base ecosystem token-token pairs + mcap pipeline.
 * Run: node scripts/audit-ecosystem-mcap.mjs
 */
import {
    enrichBaseTokenFromGecko,
    mergeBasePairsIntoMap,
    resolveBaseMarketCap,
    tokenUsdFromPair,
    pairLiquidityUsd
} from '../api/base-dex-pairs.js';

const TRACKED_BASE = [
    ['wXCH', '0x36be1d329444aef5d28df3662ec5b4f965cd93e9'],
    ['Caster', '0x09Aa909Eea859f712f2Ae3dd1872671D2363f6f4'],
    ['Spellpower', '0x145F14b876051DC443dd18D5f8a7C48c5db75847'],
    ['WizBucks', '0x39916e508e389FBB4dDC3d1a38a5801f4eE253c7'],
    ['Love', '0x817cAb331aaA4c24b4e32024FCa093AD40CBa208'],
    ['Sprout', '0xd1b771CB462a4B0e4d56Bb68b4bF832994CC8820'],
    ['Pizza', '0x84070f2c685b3d4B63c66f0B13fB83Fa6ccb4035'],
    ['BEPE', '0xBB5cBDAE23C5368557CC9A32337863eECf03cF9f'],
    ['HONK', '0xF6C04947A13481daAf4E8756B04f3D6bB7C30efF'],
    ['NECK', '0x359D5BFa1bb87598e2198EC139eE44D31Bd06FaC'],
    ['CHIA', '0x05AefaFfF978EA4F9E6ff9FA3Bc2465B90598549'],
    ['HODL', '0xb43ba3fD8ac8b16ED52CFBE72738967C2AD9cC03'],
    ['MANA', '0x4cE68125983527D1e289a0C1c70464B4bb8932ac'],
    ['HOA', '0xee642384091f4bb9ab457b875E4e209b5a0BD147'],
    ['NI', '0xf628fD48BB4A4903DdCdBb89b814B5484456fc4E'],
    ['HORSE', '0x827fc57Bc514578E8280cEE73f5e948D306aF074'],
    ['TigerBlood', '0xD999c5E89018a28deA05607837DD5DD6de26d907'],
    ['ChocoTaco', '0xBaB8a1AD71710d62e7E4c2F56c299422C6187c38']
];

const STABLE = new Set(['usdc', 'usdt', 'dai', 'usd', 'usdbc', 'weth', 'eth', 'cbeth', 'wxch']);

function isEcosystemQuote(sym) {
    const s = (sym || '').toLowerCase().replace(/^\$/, '').replace(/^w/, '');
    return !STABLE.has(s) && s.length > 0;
}

const contracts = TRACKED_BASE.map(([, c]) => c.toLowerCase());
const contractSet = new Set(contracts);
const nameByAddr = Object.fromEntries(TRACKED_BASE.map(([n, c]) => [c.toLowerCase(), n]));

// ── DexScreener batch ──
const r = await fetch(`https://api.dexscreener.com/tokens/v1/base/${contracts.join(',')}`);
const allPairs = r.ok ? (await r.json()) : [];
const basePairs = (Array.isArray(allPairs) ? allPairs : allPairs.pairs || [])
    .filter(p => (p.chainId || '').toLowerCase() === 'base');

const dexMap = mergeBasePairsIntoMap(basePairs, contractSet, {});

console.log(`DexScreener: ${basePairs.length} Base pairs, ${Object.keys(dexMap).length} tokens priced`);

// ── GeckoTerminal: batch token attributes ──
let geckoAttrs = {};
try {
    const gtUrl = `https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/${contracts.join(',')}`;
    const gt = await fetch(gtUrl);
    if (gt.ok) {
        const data = (await gt.json())?.data || [];
        for (const token of data) {
            const addr = (token?.attributes?.address || '').toLowerCase();
            if (addr) geckoAttrs[addr] = token.attributes;
        }
    }
    console.log(`GeckoTerminal batch: ${Object.keys(geckoAttrs).length} tokens returned`);
} catch (e) {
    console.log('GeckoTerminal batch failed:', e.message);
}

// Enrich all tokens from batch attrs
const peerPrices = {};
for (const [addr, row] of Object.entries(dexMap)) {
    if (row?.price > 0) peerPrices[addr] = row.price;
}

for (const [, ca] of TRACKED_BASE) {
    const key = ca.toLowerCase();
    const attr = geckoAttrs[key] || {};
    const meta = enrichBaseTokenFromGecko(attr, [], ca, peerPrices);
    const dex = dexMap[key] || {};
    dexMap[key] = {
        price: dex.price > 0 ? dex.price : meta.price,
        dexMcap: dex.dexMcap || 0,
        geckoMcap: Math.max(dex.geckoMcap || 0, meta.geckoMcap || 0),
        impliedSupply: Math.max(dex.impliedSupply || 0, meta.impliedSupply || 0),
        gtSupply: meta.gtSupply > 0 ? meta.gtSupply : (dex.gtSupply || 0),
        liq: dex.liq || 0
    };
    if (dexMap[key].price > 0) peerPrices[key] = dexMap[key].price;
}

// ── GeckoTerminal: pool calls only for tokens still missing price ──
const needsPools = TRACKED_BASE.filter(([, ca]) => {
    const dex = dexMap[ca.toLowerCase()];
    return !dex?.price || dex.price <= 0;
});

if (needsPools.length > 0) {
    console.log(`\nFetching pools for ${needsPools.length} unpriced tokens...`);
    for (const [name, ca] of needsPools) {
        const key = ca.toLowerCase();
        const attr = geckoAttrs[key] || {};
        let pools = [];
        try {
            await new Promise(res => setTimeout(res, 2000));
            const poolsR = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${key}/pools`);
            if (poolsR.ok) pools = (await poolsR.json())?.data || [];
        } catch {}
        const meta = enrichBaseTokenFromGecko(attr, pools, ca, peerPrices);
        const dex = dexMap[key] || {};
        dexMap[key] = {
            price: dex.price > 0 ? dex.price : meta.price,
            dexMcap: dex.dexMcap || 0,
            geckoMcap: Math.max(dex.geckoMcap || 0, meta.geckoMcap || 0),
            impliedSupply: Math.max(dex.impliedSupply || 0, meta.impliedSupply || 0),
            gtSupply: meta.gtSupply > 0 ? meta.gtSupply : (dex.gtSupply || 0),
            liq: dex.liq || 0
        };
        if (dexMap[key].price > 0) peerPrices[key] = dexMap[key].price;
        console.log(`  ${name}: price=$${dexMap[key].price?.toFixed(8) || '-'} pools=${pools.length}`);
    }
}

console.log('\n=== Per-token (Dex + Gecko, all assets) ===\n');
const rows = [];
for (const [name, ca] of TRACKED_BASE) {
    const key = ca.toLowerCase();
    const row = dexMap[key] || {};
    const mcap = resolveBaseMarketCap({
        gtSupply: row.gtSupply || 0,
        price: row.price || 0,
        dexMcap: row.dexMcap || 0,
        impliedSupply: row.impliedSupply || 0,
        geckoMcap: row.geckoMcap || 0
    });
    rows.push({ name, price: row.price, dexMcap: row.dexMcap, geckoMcap: row.geckoMcap, gtSupply: row.gtSupply, mcap, liq: row.liq });
}

rows.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
for (const x of rows) {
    const m = x.mcap > 0 ? `$${(x.mcap / 1e3).toFixed(2)}K` : '-';
    const p = x.price > 0 ? `$${x.price.toFixed(8)}` : '-';
    const src = x.dexMcap > 0 ? 'dex' : (x.geckoMcap > 0 ? 'gecko' : (x.gtSupply > 0 ? 'supply' : '-'));
    console.log(`${x.name.padEnd(12)} price=${p.padEnd(16)} mcap=${m.padEnd(12)} src=${src.padEnd(6)} gtSup=${x.gtSupply ? Math.round(x.gtSupply).toLocaleString() : '-'} dexFdv=${x.dexMcap ? Math.round(x.dexMcap).toLocaleString() : '-'} geckoFdv=${x.geckoMcap ? Math.round(x.geckoMcap).toLocaleString() : '-'}`);
}

// Ecosystem pairs (both sides tracked, non-stable quote)
console.log('\n=== Ecosystem pairs (tracked ↔ tracked) ===\n');
const ecoPairs = [];
for (const p of basePairs) {
    const ba = (p.baseToken?.address || '').toLowerCase();
    const qa = (p.quoteToken?.address || '').toLowerCase();
    const bs = p.baseToken?.symbol || '';
    const qs = p.quoteToken?.symbol || '';
    const bTracked = contractSet.has(ba);
    const qTracked = contractSet.has(qa);
    if (!bTracked && !qTracked) continue;
    if (bTracked && qTracked) {
        ecoPairs.push(p);
        const pB = dexMap[ba]?.price || 0;
        const pQ = dexMap[qa]?.price || 0;
        const derivedQ = tokenUsdFromPair(p, qa);
        const derivedB = tokenUsdFromPair(p, ba);
        const driftQ = pQ > 0 && derivedQ > 0 ? Math.abs(derivedQ - pQ) / pQ : null;
        const driftB = pB > 0 && derivedB > 0 ? Math.abs(derivedB - pB) / pB : null;
        console.log(`${bs}/${qs} liq=$${Math.round(pairLiquidityUsd(p))} | ${nameByAddr[ba]} merged=$${pB?.toFixed(4)} pair=$${derivedB?.toFixed(4)} | ${nameByAddr[qa]} merged=$${pQ?.toFixed(4)} pair=$${derivedQ?.toFixed(4)} drift=${((driftQ || driftB || 0) * 100).toFixed(1)}%`);
    } else if (bTracked && isEcosystemQuote(qs)) {
        // tracked base vs unknown ecosystem
    }
}
console.log(`\nTracked↔tracked pairs: ${ecoPairs.length}`);
