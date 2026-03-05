// Global leaderboard for Caster Valley
// Stores one entry per device: { deviceId, name, level, totalEssenceEarned, updatedAt }
// Single KV key cv:leaderboard = JSON object keyed by deviceId

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const LB_KEY = 'cv:leaderboard';

async function kvFetch(path, options = {}) {
    if (!KV_URL || !KV_TOKEN) throw new Error('KV not configured');
    const url = KV_URL.replace(/\/$/, '') + path;
    const resp = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${KV_TOKEN}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`KV ${resp.status}: ${text}`);
    }
    return resp.json();
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const json = (status, body) => res.status(status).json(body);

    try {
        if (req.method === 'GET') {
            let lb = {};
            try {
                const data = await kvFetch(`/get/${encodeURIComponent(LB_KEY)}`);
                lb = data?.result ? JSON.parse(data.result) : {};
            } catch (_) {}

            const entries = Object.values(lb)
                .filter(e => e.name && typeof e.totalEssenceEarned === 'number')
                .sort((a, b) => b.totalEssenceEarned - a.totalEssenceEarned)
                .slice(0, 50);

            return json(200, { ok: true, entries });
        }

        if (req.method === 'POST') {
            const { deviceId, name, level, totalEssenceEarned } = req.body || {};
            if (!deviceId || !name) return json(400, { ok: false, error: 'Missing deviceId or name' });

            // Read current leaderboard
            let lb = {};
            try {
                const data = await kvFetch(`/get/${encodeURIComponent(LB_KEY)}`);
                lb = data?.result ? JSON.parse(data.result) : {};
            } catch (_) {}

            // Upsert this player's entry
            // Only update totalEssenceEarned if it's higher (never go backwards)
            const existing = lb[deviceId];
            lb[deviceId] = {
                deviceId,
                name: String(name).slice(0, 20).replace(/[<>"]/g, ''),
                level: parseInt(level) || 1,
                totalEssenceEarned: Math.max(
                    Math.floor(totalEssenceEarned || 0),
                    existing?.totalEssenceEarned || 0
                ),
                updatedAt: Date.now()
            };

            await kvFetch(`/set/${encodeURIComponent(LB_KEY)}`, {
                method: 'POST',
                body: JSON.stringify({ value: JSON.stringify(lb) })
            });

            return json(200, { ok: true });
        }

        return json(405, { ok: false, error: 'Method not allowed' });
    } catch (err) {
        return json(500, { ok: false, error: err.message || 'Server error' });
    }
};
