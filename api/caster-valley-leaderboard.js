// Global leaderboard for Caster Valley
// Stores one entry per device: { deviceId, name, level, totalEssenceEarned, updatedAt }
// Single KV key cv:leaderboard = JSON object keyed by deviceId

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const LB_KEY = 'cv:leaderboard';

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
        throw new Error(`KV ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data.result;
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
                const raw = await kvCmd('GET', LB_KEY);
                lb = raw ? JSON.parse(raw) : {};
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

            const parsedEssence = Number(totalEssenceEarned);
            if (!Number.isFinite(parsedEssence) || parsedEssence < 0) {
                return json(400, { ok: false, error: 'Invalid totalEssenceEarned' });
            }
            const parsedLevel = Math.max(1, Math.min(parseInt(level) || 1, 999));

            // Read current leaderboard
            let lb = {};
            try {
                const raw = await kvCmd('GET', LB_KEY);
                lb = raw ? JSON.parse(raw) : {};
            } catch (_) {}

            // Upsert this player's entry
            // Only update totalEssenceEarned if it's higher (never go backwards)
            const existing = lb[deviceId];
            lb[deviceId] = {
                deviceId,
                name: String(name).slice(0, 20).replace(/[<>"]/g, ''),
                level: parsedLevel,
                totalEssenceEarned: Math.max(
                    Math.floor(parsedEssence),
                    existing?.totalEssenceEarned || 0
                ),
                updatedAt: Date.now()
            };

            await kvCmd('SET', LB_KEY, JSON.stringify(lb));

            return json(200, { ok: true });
        }

        return json(405, { ok: false, error: 'Method not allowed' });
    } catch (err) {
        return json(500, { ok: false, error: err.message || 'Server error' });
    }
};
