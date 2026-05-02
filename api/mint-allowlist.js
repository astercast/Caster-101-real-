/**
 * /api/mint-allowlist
 *
 * GET  ?address=xch1...           → { approved: bool, note: string }
 * POST (admin) body: { action, address, note }  → manage allowlist
 *   action: 'add' | 'remove' | 'list' | 'clear'
 *
 * Admin auth: Authorization: Bearer <MINT_ADMIN_SECRET>
 *
 * Storage: Vercel Blob at 'caster101-mint/allowlist.json'
 * Format:  { addresses: { "xch1...": { addedAt, note } } }
 */

import { put, head, del } from '@vercel/blob';

const BLOB_KEY = 'caster101-mint/allowlist.json';

// ── Read allowlist from Blob ──
async function readAllowlist() {
    try {
        // head() gives us the URL without downloading all objects
        const meta = await head(BLOB_KEY).catch(() => null);
        if (!meta) return { addresses: {} };
        const r = await fetch(meta.url, { headers: { 'Cache-Control': 'no-store' } });
        if (!r.ok) return { addresses: {} };
        return await r.json();
    } catch {
        return { addresses: {} };
    }
}

// ── Write allowlist to Blob ──
async function writeAllowlist(data) {
    await put(BLOB_KEY, JSON.stringify(data), {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'application/json',
    });
}

// ── Bech32m Chia address basic validation ──
function isValidChiaAddress(addr) {
    return typeof addr === 'string' && /^xch1[a-z0-9]{50,}$/.test(addr);
}

// ── Admin auth check ──
function isAdmin(req) {
    const secret = process.env.MINT_ADMIN_SECRET;
    if (!secret) return false; // no secret set = admin disabled
    const auth = req.headers['authorization'] || '';
    return auth === `Bearer ${secret}`;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(204).end();

    // ── GET: check a single address ──
    if (req.method === 'GET') {
        const address = (req.query.address || '').toLowerCase().trim();
        if (!address) return res.status(400).json({ error: 'address required' });

        const phase = getPhase();

        // Public mint — always approved
        if (phase === 'public') {
            return res.status(200).json({ approved: true, note: 'Public mint open' });
        }
        // Closed — never approved
        if (phase === 'closed' || phase === 'soon') {
            return res.status(200).json({ approved: false, note: 'Mint not open' });
        }

        // Allowlist phase
        const list = await readAllowlist();
        const entry = list.addresses[address];
        if (entry) {
            return res.status(200).json({ approved: true, note: entry.note || null, addedAt: entry.addedAt });
        }
        return res.status(200).json({ approved: false, note: null });
    }

    // ── POST: admin management ──
    if (req.method === 'POST') {
        if (!isAdmin(req)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        let body;
        try {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch {
            return res.status(400).json({ error: 'Invalid JSON' });
        }

        const { action, address, note, addresses: bulkAddresses } = body;

        // List all
        if (action === 'list') {
            const list = await readAllowlist();
            const arr = Object.entries(list.addresses).map(([addr, meta]) => ({ address: addr, ...meta }));
            return res.status(200).json({ count: arr.length, addresses: arr });
        }

        // Add single
        if (action === 'add') {
            const addr = (address || '').toLowerCase().trim();
            if (!isValidChiaAddress(addr)) return res.status(400).json({ error: 'Invalid Chia address' });
            const list = await readAllowlist();
            list.addresses[addr] = { addedAt: new Date().toISOString(), note: note || null };
            await writeAllowlist(list);
            return res.status(200).json({ ok: true, count: Object.keys(list.addresses).length });
        }

        // Bulk add
        if (action === 'bulk_add') {
            if (!Array.isArray(bulkAddresses)) return res.status(400).json({ error: 'addresses array required' });
            const list = await readAllowlist();
            let added = 0;
            for (const a of bulkAddresses) {
                const addr = (typeof a === 'string' ? a : a.address || '').toLowerCase().trim();
                const n    = typeof a === 'object' ? (a.note || null) : null;
                if (!isValidChiaAddress(addr)) continue;
                list.addresses[addr] = { addedAt: new Date().toISOString(), note: n };
                added++;
            }
            await writeAllowlist(list);
            return res.status(200).json({ ok: true, added, count: Object.keys(list.addresses).length });
        }

        // Remove single
        if (action === 'remove') {
            const addr = (address || '').toLowerCase().trim();
            const list = await readAllowlist();
            const existed = !!list.addresses[addr];
            delete list.addresses[addr];
            await writeAllowlist(list);
            return res.status(200).json({ ok: true, removed: existed, count: Object.keys(list.addresses).length });
        }

        // Clear all
        if (action === 'clear') {
            await writeAllowlist({ addresses: {} });
            return res.status(200).json({ ok: true, count: 0 });
        }

        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}

function getPhase() {
    try {
        if (process.env.MINT_CONFIG) {
            return JSON.parse(process.env.MINT_CONFIG).phase || 'soon';
        }
    } catch {}
    return 'soon';
}
