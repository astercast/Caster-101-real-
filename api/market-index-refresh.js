const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
};

function getOrigin(req) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

async function safeFetch(url, timeout = 28000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return response;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

export default async function handler(req, res) {
    Object.entries(HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${cronSecret}`) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }
    }

    try {
        const origin = getOrigin(req);
        const response = await safeFetch(`${origin}/api/market-index?refresh=1&t=${Date.now()}`, 28000);
        if (!response.ok) {
            return res.status(502).json({ ok: false, error: `refresh_failed_${response.status}` });
        }

        const snapshot = await response.json();
        return res.status(200).json({
            ok: true,
            rebuilt: true,
            source: snapshot?.source || 'unknown',
            savedAt: snapshot?.savedAt || null
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'refresh_failed' });
    }
}
