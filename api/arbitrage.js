import { fetchLiveBasePriceMap } from './live-base-prices.js';
import { fetchLiveChiaPriceData } from './live-chia-prices.js';
import {
    computeArbitrageSpread,
    findPairedBaseToken,
    pairingKey
} from './token-pairing.js';

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

function asNumber(v) {
    const n = parseFloat(v || 0);
    return Number.isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    try {
        const minSpreadPct = Math.max(0, asNumber(req.query?.minSpreadPct || 0));
        const origin = getOrigin(req);

        const snapshotResp = await safeFetch(`${origin}/api/market-index`, 12000);
        if (!snapshotResp.ok) {
            return res.status(502).json({ ok: false, error: `market_index_${snapshotResp.status}` });
        }
        const snapshot = await snapshotResp.json();
        const baseTokens = Array.isArray(snapshot.base) ? snapshot.base : [];
        const chiaTokens = Array.isArray(snapshot.chia) ? snapshot.chia : [];

        const baseWithContract = baseTokens.filter(t => t.contract);
        const [chiaLive, baseLive] = await Promise.all([
            fetchLiveChiaPriceData(origin),
            fetchLiveBasePriceMap(baseWithContract)
        ]);

        const { xchUsd, prices: chiaPrices, changes: chiaChanges } = chiaLive;

        function liveChiaPrice(token) {
            if (token.assetId === 'Native') return xchUsd;
            const aid = (token.assetId || '').toLowerCase();
            return chiaPrices[aid] || asNumber(token.price);
        }

        function liveBasePrice(token) {
            const ca = (token.contract || '').toLowerCase();
            return baseLive[ca]?.price || asNumber(token.price);
        }

        function liveChiaChange(token) {
            const aid = (token.assetId || '').toLowerCase();
            return chiaChanges[aid] ?? asNumber(token.change24h);
        }

        function liveBaseChange(token) {
            const ca = (token.contract || '').toLowerCase();
            return baseLive[ca]?.change24h ?? asNumber(token.change24h);
        }

        const opportunities = [];

        for (const chiaToken of chiaTokens) {
            if (chiaToken.assetId === 'Native') continue;

            const baseToken = findPairedBaseToken(chiaToken, baseTokens);
            if (!baseToken) continue;

            const chiaPrice = liveChiaPrice(chiaToken);
            const basePrice = liveBasePrice(baseToken);
            const spread = computeArbitrageSpread(chiaPrice, basePrice);

            if (!spread.ok || spread.absSpreadPct < minSpreadPct) continue;

            const key = pairingKey(chiaToken);

            opportunities.push({
                key,
                name: chiaToken.displayName || chiaToken.name || baseToken.displayName || baseToken.name || key,
                symbol: chiaToken.symbol || baseToken.symbol || null,
                base: {
                    price: spread.basePrice,
                    contract: baseToken.contract || null,
                    change24h: liveBaseChange(baseToken),
                    marketCap: asNumber(baseToken.marketCap),
                    live: baseLive[(baseToken.contract || '').toLowerCase()]?.price > 0
                },
                chia: {
                    price: spread.chiaPrice,
                    assetId: chiaToken.assetId || null,
                    change24h: liveChiaChange(chiaToken),
                    marketCap: asNumber(chiaToken.marketCap),
                    live: chiaPrices[(chiaToken.assetId || '').toLowerCase()] > 0
                },
                spreadAbs: spread.spreadAbs,
                spreadPct: spread.spreadPct,
                absSpreadPct: spread.absSpreadPct,
                direction: spread.direction
            });
        }

        opportunities.sort((a, b) => b.absSpreadPct - a.absSpreadPct);

        return res.status(200).json({
            ok: true,
            generatedAt: Date.now(),
            priceSource: 'live',
            snapshotAge: snapshot.savedAt ? Date.now() - snapshot.savedAt : null,
            xchUsd,
            minSpreadPct,
            pairCount: opportunities.length,
            opportunities
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'arbitrage_failed' });
    }
}
