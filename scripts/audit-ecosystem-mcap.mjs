/**
 * Audit Base emoji market pricing — mirrors production pipeline.
 * Run: node scripts/audit-ecosystem-mcap.mjs
 */
import {
    enrichBaseTokenFromGecko,
    mergeBasePairsIntoMap,
    mergeGeckoIntoDexRow,
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

const contracts = TRACKED_BASE.map(([, c]) => c.toLowerCase());
const contractSet = new Set(contracts);
const nameByAddr = Object.fromEntries(TRACKED_BASE.map(([n, c]) => [c.toLowerCase(), n]));
const dexMap = {};

const batch = await fetch(`https://api.dexscreener.com/tokens/v1/base/${contracts.join(',')}`);
if (batch.ok) {
    const data = await batch.json();
    mergeBasePairsIntoMap(Array.isArray(data) ? data : (data.pairs || []), contractSet, dexMap);
}

for (const [, ca] of TRACKED_BASE) {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca.toLowerCase()}`);
    if (r.ok) mergeBasePairsIntoMap((await r.json()).pairs || [], contractSet, dexMap);
    await new Promise(res => setTimeout(res, 80));
}

let geckoAttrs = {};
const gt = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/${contracts.join(',')}`);
if (gt.ok) {
    for (const token of ((await gt.json())?.data || [])) {
        const addr = (token?.attributes?.address || '').toLowerCase();
        if (addr) geckoAttrs[addr] = token.attributes;
    }
}

const peerPrices = {};
for (const [addr, row] of Object.entries(dexMap)) {
    if (row?.price > 0) peerPrices[addr] = row.price;
}

for (const [, ca] of TRACKED_BASE) {
    const key = ca.toLowerCase();
    const dex = dexMap[key] || {};
    const meta = enrichBaseTokenFromGecko(geckoAttrs[key] || {}, [], ca, peerPrices, dex.price > 0);
    dexMap[key] = mergeGeckoIntoDexRow(dex, meta);
}

const needsPools = TRACKED_BASE.filter(([, ca]) => !dexMap[ca.toLowerCase()]?.price);
for (const [name, ca] of needsPools) {
    await new Promise(res => setTimeout(res, 120));
    let pools = [];
    try {
        const poolsR = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${ca.toLowerCase()}/pools`);
        if (poolsR.ok) pools = (await poolsR.json())?.data || [];
    } catch {}
    const key = ca.toLowerCase();
    const meta = enrichBaseTokenFromGecko(geckoAttrs[key] || {}, pools, ca, peerPrices, false);
    dexMap[key] = mergeGeckoIntoDexRow(dexMap[key] || {}, meta);
    console.log(`  Gecko pools: ${name} price=${dexMap[key]?.price || '-'}`);
}

console.log('\n=== Base emoji market (fixed pipeline) ===\n');
const rows = [];
for (const [name, ca] of TRACKED_BASE) {
    const row = dexMap[ca.toLowerCase()] || {};
    const mcap = resolveBaseMarketCap({
        gtSupply: row.gtSupply || 0,
        price: row.price || 0,
        dexMcap: row.dexMcap || 0,
        impliedSupply: row.impliedSupply || 0,
        geckoMcap: row.geckoMcap || 0
    });
    rows.push({ name, ...row, mcap });
}

rows.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
for (const x of rows) {
    const p = x.price > 0 ? `$${x.price.toFixed(6)}` : '-';
    const m = x.mcap > 0 ? `$${(x.mcap / 1e3).toFixed(1)}K` : '-';
    const src = x.dexMcap > 0 ? 'dex' : (x.geckoMcap > 0 ? 'gecko' : '-');
    console.log(`${x.name.padEnd(12)} price=${p.padEnd(14)} mcap=${m.padEnd(10)} [${src}]`);
}

console.log('\n=== Tracked ↔ tracked pairs ===\n');
const caster = '0x09aa909eea859f712f2ae3dd1872671d2363f6f4';
const dr = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${caster}`);
for (const p of ((await dr.json()).pairs || []).filter(x => (x.chainId || '').toLowerCase() === 'base')) {
    const ba = (p.baseToken?.address || '').toLowerCase();
    const qa = (p.quoteToken?.address || '').toLowerCase();
    if (contractSet.has(ba) && contractSet.has(qa)) {
        console.log(`${p.baseToken?.symbol}/${p.quoteToken?.symbol} liq=$${Math.round(pairLiquidityUsd(p))} caster=$${tokenUsdFromPair(p, caster)?.toFixed(2)}`);
    }
}
