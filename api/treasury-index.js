const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
};

const INDEX_KEY = 'caster101-index/treasury.json';
const MEM_TTL_MS = 2 * 60 * 1000;       // in-memory hot cache: 2 min
const BLOB_TTL_MS = 30 * 60 * 1000;     // blob SWR threshold: 30 min — older → background rebuild

const BASE_WALLET_1 = '0x8d8cb6D19E32115823Cf0008701A84fB07F43467';
const BASE_WALLET_2 = '0xEEDC069F861880eC1B5f41c9bC7a747DC1cE32b9';
const CHIA_WALLET_1 = 'xch10na8nqys9afs0fl74vvd6xl3akgu77p8mvjsp2ywy7rhq2s0jqys3nf7dl';
const CHIA_WALLET_2 = 'xch1g477lha2wjjq9634kgqmryf4gplft9cjgv2vd29tq3ya26glwlkqp6pyex';
const CHIA_WALLET_3 = 'xch1el40ydk4v2ccdq2l8d28wvr8hnndar0xywfgqel36f85ps8gj9jqfrm64j';

let _memSnapshot = null;
let _memAt = 0;
let _inflight = null;

function getOrigin(req) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

async function safeFetch(url, timeout = 20000) {
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
        const response = await safeFetch(info.url, 10000);
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
        console.warn('[treasury-index] Blob write failed:', e.message);
    }
}

function mergeBaseTokens(arr1, arr2) {
    const map = new Map();
    for (const token of [...arr1, ...arr2]) {
        const isLP = token.type === 'lp';
        const key = isLP ? `${token.contract || token.name || token.symbol}-${Math.random().toString(36).slice(2, 8)}` : (token.contract || token.symbol || token.name);
        if (!map.has(key)) {
            map.set(key, { ...token });
        } else {
            const existing = map.get(key);
            existing.balance = (existing.balance || 0) + (token.balance || 0);
            existing.value = (existing.value || 0) + (token.value || 0);
        }
    }
    return Array.from(map.values());
}

function buildNftCollections(allNfts) {
    const map = {};
    for (const nft of allNfts) {
        const cid = nft.collection_id || 'uncategorized';
        if (!map[cid]) {
            const rawName = (nft.name || '').trim();
            map[cid] = {
                id: cid,
                colId: cid,
                name: rawName.replace(/\s+#\d+[\w\s]*$/, '').trim() || rawName || 'Unknown Collection',
                image: nft.preview_url || '',
                count: 0,
                floor_xch: 0
            };
        }
        map[cid].count++;
        if (!map[cid].image && nft.preview_url) map[cid].image = nft.preview_url;
    }
    return Object.values(map).sort((a, b) => b.count - a.count);
}

async function buildSnapshot(req) {
    const origin = getOrigin(req);

    const [base1, base2, chiaTreasury, xchData] = await Promise.all([
        safeFetch(`${origin}/api/treasury-comprehensive?address=${BASE_WALLET_1}&chain=base`, 25000).then(r => r.ok ? r.json() : {}).catch(() => ({})),
        safeFetch(`${origin}/api/treasury-comprehensive?address=${BASE_WALLET_2}&chain=base`, 25000).then(r => r.ok ? r.json() : {}).catch(() => ({})),
        safeFetch(`${origin}/api/chia-cat-prices?mode=treasury&wallets=${encodeURIComponent([CHIA_WALLET_1, CHIA_WALLET_2, CHIA_WALLET_3].join(','))}`, 45000)
            .then(r => r.ok ? r.json() : {}).catch(() => ({})),
        safeFetch(`${origin}/api/coingecko-proxy?ids=chia&vs_currencies=usd&t=${Date.now()}`, 8000).then(r => r.ok ? r.json() : {}).catch(() => ({}))
    ]);

    const baseLp1 = (base1.tokens || []).filter(t => t.type === 'lp');
    const baseLp2 = (base2.tokens || []).filter(t => t.type === 'lp');
    const baseReg1 = (base1.tokens || []).filter(t => t.type !== 'lp');
    const baseReg2 = (base2.tokens || []).filter(t => t.type !== 'lp');
    const baseTokens = [...mergeBaseTokens(baseReg1, baseReg2), ...baseLp1, ...baseLp2];
    const baseTotal = (base1.total || 0) + (base2.total || 0);
    const baseData = {
        tokens: baseTokens,
        total: baseTotal,
        wallets: [BASE_WALLET_1, BASE_WALLET_2]
    };

    const xchPrice = parseFloat(xchData?.chia?.usd || 2.20);
    const wallets = Array.isArray(chiaTreasury?.wallets) ? chiaTreasury.wallets : [];

    const chiaMap = new Map();
    let totalNfts = [];

    for (const wallet of wallets) {
        const xchBal = parseFloat(wallet.xchBal || 0);
        if (xchBal > 0) {
            const key = 'XCH_NATIVE';
            if (!chiaMap.has(key)) {
                chiaMap.set(key, {
                    symbol: 'XCH',
                    name: 'Chia',
                    assetId: key,
                    balance: 0,
                    price: xchPrice,
                    value: 0,
                    type: 'native',
                    image: ''
                });
            }
            const ex = chiaMap.get(key);
            ex.balance += xchBal;
            ex.value += xchBal * xchPrice;
        }

        for (const token of (wallet.tokens || [])) {
            const key = token.asset_id || token.symbol;
            const balance = parseFloat(token.balance || 0);
            const price = parseFloat(token.price || 0);
            const value = parseFloat(token.total_value || 0) || (balance * price);

            if (!chiaMap.has(key)) {
                chiaMap.set(key, {
                    symbol: token.symbol || token.name || '?',
                    name: token.name || token.symbol || 'Unknown CAT',
                    assetId: token.asset_id || key,
                    balance: 0,
                    price,
                    value: 0,
                    type: 'cat',
                    image: ''
                });
            }

            const ex = chiaMap.get(key);
            ex.balance += balance;
            ex.value += value;
            if (!ex.price && price > 0) ex.price = price;
        }

        totalNfts = totalNfts.concat(wallet.nfts || []);
    }

    const chiaTokens = Array.from(chiaMap.values());
    const chiaTotal = chiaTokens.reduce((sum, t) => sum + (t.value || 0), 0);
    const chiaData = {
        tokens: chiaTokens,
        total: chiaTotal,
        xchPrice
    };

    const collections = buildNftCollections(totalNfts);
    const nftData = {
        collections,
        totalNFTs: totalNfts.length,
        totalCollections: collections.length,
        totalValue: 0,
        totalXch: 0
    };

    return {
        version: 1,
        savedAt: Date.now(),
        baseData,
        chiaData,
        nftData
    };
}

export default async function handler(req, res) {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=1800');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // ── POST: browser pushes a client-built snapshot (has real Spacescan CAT data) ──
    if (req.method === 'POST') {
        try {
            const body = req.body || {};
            const chiaOk = Array.isArray(body.chiaData?.tokens) && body.chiaData.tokens.some(t => t.type !== 'native');
            if (!body.baseData || !chiaOk) {
                return res.status(400).json({ error: 'Invalid snapshot: missing baseData or chiaData CATs' });
            }
            const snapshot = {
                version: 1,
                savedAt: Date.now(),
                baseData: body.baseData,
                chiaData: body.chiaData,
                nftData: body.nftData || { collections: [], totalNFTs: 0, totalCollections: 0, totalValue: 0, totalXch: 0 }
            };
            _memSnapshot = snapshot;
            _memAt = Date.now();
            await saveBlobSnapshot(snapshot);
            console.log(`[treasury-index] Browser snapshot saved: ${snapshot.chiaData.tokens.length} chia tokens, $${(snapshot.baseData.total||0).toFixed(2)} base`);
            return res.status(200).json({ ok: true, savedAt: snapshot.savedAt });
        } catch (e) {
            return res.status(500).json({ error: 'Failed to save snapshot', detail: String(e?.message || e) });
        }
    }

    try {
        const force = req.query?.refresh === '1';

        // 1. In-memory hot cache (2 min)
        if (!force && _memSnapshot && (Date.now() - _memAt < MEM_TTL_MS)) {
            return res.status(200).json({ ..._memSnapshot, source: 'memory' });
        }

        // 2. Blob snapshot — stale-while-revalidate (serve immediately, rebuild in background when > 30 min old)
        if (!force) {
            const blobSnap = await loadBlobSnapshot();
            if (blobSnap?.savedAt && blobSnap.baseData && blobSnap.chiaData) {
                const chiaOk = Array.isArray(blobSnap.chiaData.tokens) && blobSnap.chiaData.tokens.some(t => t.type !== 'native');
                if (!chiaOk) {
                    // Blob has only XCH (chia-cat-prices timed out / Spacescan blocked Vercel IPs).
                    // Serve it anyway so the frontend gets a fast response and falls through
                    // to browser-direct loadChiaTreasury. Trigger background rebuild so next
                    // visit has a chance of picking up CATs (browser POST will update the blob).
                    console.warn('[treasury-index] Blob has no CAT data — serving partial (XCH only), background rebuild queued');
                    _memSnapshot = blobSnap;
                    _memAt = Date.now();
                    if (!_inflight) {
                        _inflight = buildSnapshot(req)
                            .then(async snapshot => {
                                _memSnapshot = snapshot;
                                _memAt = Date.now();
                                const snapChiaOk = Array.isArray(snapshot.chiaData?.tokens) && snapshot.chiaData.tokens.some(t => t.type !== 'native');
                                if (snapChiaOk) await saveBlobSnapshot(snapshot);
                                return snapshot;
                            })
                            .finally(() => { _inflight = null; });
                    }
                    return res.status(200).json({ ...blobSnap, source: 'blob-chia-partial' });
                }

                _memSnapshot = blobSnap;
                _memAt = Date.now();
                const blobAge = Date.now() - blobSnap.savedAt;

                if (blobAge > BLOB_TTL_MS && !_inflight) {
                    // Blob is stale — kick off background rebuild, respond immediately
                    console.log(`[treasury-index] Blob stale (${Math.round(blobAge/60000)}m old) — SWR background rebuild`);
                    const oldNftData = blobSnap.nftData;
                    _inflight = buildSnapshot(req)
                        .then(async snapshot => {
                            // Server cannot fetch NFTs (Spacescan blocks Vercel IPs for wallet endpoints).
                            // Preserve NFT data from the previous blob so browser-pushed NFTs aren't lost.
                            if ((!snapshot.nftData || snapshot.nftData.totalNFTs === 0) && oldNftData?.totalNFTs > 0) {
                                snapshot.nftData = oldNftData;
                                console.log(`[treasury-index] Preserved ${oldNftData.totalNFTs} NFTs from prior blob`);
                            }
                            _memSnapshot = snapshot;
                            _memAt = Date.now();
                            await saveBlobSnapshot(snapshot);
                            return snapshot;
                        })
                        .finally(() => { _inflight = null; });
                    // Respond with stale-but-valid blob right away
                    return res.status(200).json({ ...blobSnap, source: 'blob-stale' });
                }

                return res.status(200).json({ ...blobSnap, source: 'blob' });
            }
        }

        // 3. No usable blob — build fresh (blocks until done)
        if (!_inflight || force) {
            _inflight = buildSnapshot(req)
                .then(async snapshot => {
                    _memSnapshot = snapshot;
                    _memAt = Date.now();
                    // Only persist blob if Chia data actually loaded (needs at least one CAT/LP beyond XCH)
                    const chiaOk = Array.isArray(snapshot.chiaData?.tokens) && snapshot.chiaData.tokens.some(t => t.type !== 'native');
                    if (chiaOk) {
                        await saveBlobSnapshot(snapshot);
                    } else {
                        console.warn('[treasury-index] Skipping blob save — chiaData empty (chia-cat-prices may have timed out)');
                    }
                    return snapshot;
                })
                .finally(() => {
                    _inflight = null;
                });
        }

        const fresh = await _inflight;
        return res.status(200).json({ ...fresh, source: 'fresh' });
    } catch (e) {
        if (_memSnapshot) return res.status(200).json({ ..._memSnapshot, source: 'memory-stale', error: String(e?.message || e) });
        return res.status(500).json({ error: 'treasury index failed', detail: String(e?.message || e) });
    }
}
