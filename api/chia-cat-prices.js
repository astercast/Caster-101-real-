// chia-cat-prices.js — Vercel API route
// MODE 1: emoji market prices (default) - Dexie tickers (reliable) + Spacescan (best effort)
//   Browser handles supply fetching directly via Spacescan (Vercel IPs often blocked)
// MODE 2: treasury wallets (?mode=treasury&wallets=...)

const CAT_IDS = [
    'a09af8b0d12b27772c64f89cf0d1db95186dca5b1871babc5108ff44f36305e6', // CASTER
    'eb2155a177b6060535dd8e72e98ddb0c77aea21fab53737de1c1ced3cb38e4c4', // SPELLPOWER
    'ae1536f56760e471ad85ead45f00d680ff9cca73b8cc3407be778f1c0c606eac', // WIZ/BYC
    '70010d83542594dd44314efbae75d82b3d9ae7d946921ed981a6cd08f0549e50', // LOVE
    'ab558b1b841365a24d1ff2264c55982e55664a8b6e45bc107446b7e667bb463b', // SPROUT
    'dd37f678dda586fad9b1daeae1f7c5c137ffa6d947e1ed5c7b4f3c430da80638', // PIZZA
];

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' };
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function timedFetch(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const r = await fetch(url, { headers: UA, signal: ctrl.signal });
        clearTimeout(timer);
        return r;
    } catch (e) { clearTimeout(timer); throw e; }
}

// Spacescan price — best effort, may 403 from Vercel IPs
async function getSpacescanPrice(assetId) {
    try {
        const r = await timedFetch('https://api.spacescan.io/cat/info/' + assetId, 5000);
        if (!r.ok) return null;
        const d = await r.json();
        const data = d?.data || {};
        return {
            price: parseFloat(data.amount_price || 0),
            change: parseFloat(data.pricepercentage || 0),
            supply: parseFloat(data.circulating_supply || data.total_supply || 0),
            source: 'spacescan'
        };
    } catch (_) { return null; }
}

// Dexie individual offer fallback
async function getDexieBestAsk(assetId, xchUsd) {
    try {
        const r = await timedFetch('https://dexie.space/v1/offers?offered=' + assetId + '&requested=xch&page=1&page_size=5&sort=price&order=asc', 7000);
        if (!r.ok) return null;
        const d = await r.json();
        const offers = (d.offers || []).filter(o => o.price > 0);
        if (!offers.length) return null;
        return { price: Math.min(...offers.map(o => o.price)) * xchUsd, source: 'dexie-offer' };
    } catch (_) { return null; }
}

// ── TREASURY MODE ──

async function fetchTreasuryWallets(wallets) {
    const results = [];
    for (const wallet of wallets) {
        const walletData = { wallet, xchBal: 0, nfts: [], tokens: [] };
        try {
            try {
                const balResp = await timedFetch(`https://xchscan.com/api/account/balance?address=${wallet}`, 10000);
                if (balResp.ok) {
                    const balData = await balResp.json();
                    walletData.xchBal = parseFloat(balData?.xch || 0);
                }
            } catch (e) { console.warn(`[treasury] xchscan balance failed: ${e.message}`); }
            await sleep(300);

            try {
                const nftResp = await timedFetch(`https://api.spacescan.io/address/nft-balance/${wallet}`, 12000);
                if (nftResp.ok) {
                    const nftData = await nftResp.json();
                    walletData.nfts = (nftData?.balance || []).map(n => ({
                        nft_id: n.nft_id || '', name: n.name || '',
                        collection_id: n.collection_id || '', preview_url: n.preview_url || ''
                    }));
                }
            } catch (_) {}
            await sleep(800);

            try {
                const tokResp = await timedFetch(`https://api.spacescan.io/address/token-balance/${wallet}`, 25000);
                if (tokResp.ok) {
                    const tokData = await tokResp.json();
                    walletData.tokens = (tokData?.data || [])
                        .filter(t => parseFloat(t.balance || 0) > 0)
                        .map(t => ({
                            asset_id: t.asset_id || '', name: t.name || t.symbol || '',
                            symbol: t.symbol || t.name || '', balance: parseFloat(t.balance || 0),
                            price: parseFloat(t.price || 0), total_value: parseFloat(t.total_value || 0)
                        }));
                }
            } catch (_) {}
            await sleep(800);

            console.log(`[treasury] ${wallet.slice(-8)}: ${walletData.xchBal.toFixed(4)} XCH, ${walletData.nfts.length} NFTs, ${walletData.tokens.length} tokens`);
        } catch (err) {
            console.error(`[treasury] Error: ${err.message}`);
        }
        results.push(walletData);
    }
    return results;
}

// ── HANDLER ──

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const t0 = Date.now();
    const params = req.query || {};

    // TREASURY MODE
    if (params.mode === 'treasury' && params.wallets) {
        const wallets = params.wallets.split(',').map(w => w.trim()).filter(Boolean);
        try {
            const walletData = await fetchTreasuryWallets(wallets);
            return res.status(200).json({ ok: true, wallets: walletData, elapsed_ms: Date.now() - t0 });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    // EMOJI MARKET MODE
    // Strategy: Dexie tickers (reliable from Vercel) + Spacescan best-effort for price/change
    // Browser handles circulating supply fetching directly
    try {
        // Fetch all sources in parallel
        const [xchResp, dexieTickers, ...catResults] = await Promise.all([
            timedFetch('https://api.coingecko.com/api/v3/simple/price?ids=chia&vs_currencies=usd', 6000)
                .then(r => r.ok ? r.json() : {}).catch(() => ({})),
            timedFetch('https://dexie.space/v2/prices/tickers', 8000)
                .then(r => r.ok ? r.json() : {}).catch(() => ({})),
            // Spacescan calls — best effort, may fail from Vercel IPs
            ...CAT_IDS.map((id, i) =>
                sleep(i * 300).then(() => getSpacescanPrice(id))
            ),
        ]);

        const xchUsd = xchResp?.chia?.usd || 3;

        // Build Dexie ticker map: assetId -> priceUsd
        const tickerMap = {};
        for (const tick of (dexieTickers.tickers || [])) {
            const bid = (tick.base_id || '').toLowerCase();
            const lp = parseFloat(tick.last_price || 0);
            if (bid && lp > 0) tickerMap[bid] = lp * xchUsd;
        }

        const prices = {}, changes = {}, mcaps = {}, sources = {};

        for (let i = 0; i < CAT_IDS.length; i++) {
            const id = CAT_IDS[i];
            const ss = catResults[i];
            const dexiePrice = tickerMap[id.toLowerCase()] || 0;

            let price = 0, change = 0, src = 'none';

            // Priority 1: Spacescan (has price + 24h change + supply)
            if (ss && ss.price > 0) {
                price = ss.price;
                change = ss.change || 0;
                src = 'spacescan';
                if (ss.supply > 0) mcaps[id] = ss.supply * price;
            }
            // Priority 2: Dexie tickers (reliable, always works from Vercel)
            else if (dexiePrice > 0) {
                price = dexiePrice;
                src = 'dexie';
                if (ss && ss.change) change = ss.change;
            }

            prices[id] = price;
            changes[id] = change;
            if (!mcaps[id]) mcaps[id] = 0;
            sources[id] = src;
        }

        // Fallback: individual Dexie offers for tokens still missing a price
        const missing = CAT_IDS.filter(id => !prices[id] || prices[id] === 0);
        if (missing.length > 0) {
            const dr = await Promise.all(missing.map(id => getDexieBestAsk(id, xchUsd)));
            for (let i = 0; i < missing.length; i++) {
                const id = missing[i], r = dr[i];
                if (r && r.price > 0) {
                    prices[id] = r.price;
                    sources[id] = 'dexie-offer';
                }
            }
        }

        console.log(`[emoji-market] ${CAT_IDS.filter(id => prices[id] > 0).length}/${CAT_IDS.length} priced in ${Date.now()-t0}ms`);
        return res.status(200).json({ prices, changes, mcaps, xch_usd: xchUsd, sources, success: true, elapsed_ms: Date.now() - t0 });
    } catch (e) {
        console.error(`[emoji-market] Error: ${e.message}`);
        return res.status(200).json({ prices: {}, changes: {}, mcaps: {}, xch_usd: 3, success: false, error: e.message });
    }
}
