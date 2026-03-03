const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
};

const MEM_TTL_MS = 5 * 60 * 1000;
const memoryCache = new Map();

async function blobApi() {
    try {
        const mod = await import('@vercel/blob');
        if (!mod || typeof mod.put !== 'function' || typeof mod.head !== 'function') return null;
        return mod;
    } catch {
        return null;
    }
}

async function safeFetch(url, timeout = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                Accept: 'text/html,application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        clearTimeout(timer);
        return response;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

function parseNormieStats(html) {
    const hpMatch = html.match(/HP:\s*(\d+)/i);
    return {
        hp: hpMatch ? parseInt(hpMatch[1], 10) : 10
    };
}

function blobKey(normieId) {
    return `caster101-index/game/normie-${normieId}.json`;
}

async function loadBlob(normieId) {
    const api = await blobApi();
    if (!api) return null;
    try {
        const info = await api.head(blobKey(normieId));
        if (!info?.url) return null;
        const response = await safeFetch(info.url, 8000);
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

async function saveBlob(normieId, data) {
    const api = await blobApi();
    if (!api) return;
    try {
        await api.put(blobKey(normieId), JSON.stringify(data), {
            access: 'public',
            contentType: 'application/json',
            addRandomSuffix: false,
            allowOverwrite: true
        });
    } catch (e) {
        console.warn('[game-index] Blob write failed:', e.message);
    }
}

export default async function handler(req, res) {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const normieId = String(req.query?.normieId || '').trim();
    const force = req.query?.refresh === '1';
    if (!normieId) return res.status(400).json({ error: 'Missing normieId' });

    const mem = memoryCache.get(normieId);
    if (!force && mem && (Date.now() - mem.ts) < MEM_TTL_MS) {
        return res.status(200).json({ ...mem.data, source: 'memory' });
    }

    if (!force) {
        const cached = await loadBlob(normieId);
        if (cached?.normieId) {
            memoryCache.set(normieId, { ts: Date.now(), data: cached });
            return res.status(200).json({ ...cached, source: 'blob' });
        }
    }

    try {
        const response = await safeFetch(`https://www.normies.art/normiecard?id=${encodeURIComponent(normieId)}`, 12000);
        if (!response.ok) throw new Error(`normies.art returned ${response.status}`);
        const html = await response.text();
        const stats = parseNormieStats(html);
        const fresh = {
            normieId,
            ...stats,
            savedAt: Date.now()
        };
        memoryCache.set(normieId, { ts: Date.now(), data: fresh });
        await saveBlob(normieId, fresh);
        return res.status(200).json({ ...fresh, source: 'fresh' });
    } catch (e) {
        const stale = memoryCache.get(normieId)?.data;
        if (stale) return res.status(200).json({ ...stale, source: 'memory-stale', error: String(e?.message || e) });
        return res.status(500).json({ error: 'game index failed', detail: String(e?.message || e) });
    }
}
