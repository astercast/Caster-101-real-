// Cloud save for Caster Valley (Upstash Redis REST API)
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const json = (res, status, body) => { res.status(status).json(body); };

// Upstash Redis REST: POST to root with ["COMMAND", ...args] body
async function kvCmd(...args) {
    if (!KV_URL || !KV_TOKEN) throw new Error('KV not configured');
    const resp = await fetch(KV_URL.replace(/\/$/, ''), {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`KV error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data.result;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const deviceId = req.query?.deviceId || req.body?.deviceId;
        if (!deviceId) return json(res, 400, { ok: false, error: 'Missing deviceId' });
        const key = `cv:save:${deviceId}`;

        if (req.method === 'GET') {
            const raw = await kvCmd('GET', key);
            const saved = raw ? JSON.parse(raw) : null;
            return json(res, 200, { ok: true, save: saved });
        }

        if (req.method === 'POST') {
            const body = req.body || {};
            if (!body.save || typeof body.save !== 'object') {
                return json(res, 400, { ok: false, error: 'Missing save payload' });
            }
            const serialized = JSON.stringify(body.save);
            if (serialized.length > 500000) {
                return json(res, 413, { ok: false, error: 'Save payload too large' });
            }
            if (!body.save.savedAt) body.save.savedAt = Date.now();
            await kvCmd('SET', key, serialized);
            return json(res, 200, { ok: true });
        }

        return json(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (err) {
        return json(res, 500, { ok: false, error: err.message || 'Server error' });
    }
};
