/**
 * GET /api/mint-config
 * Returns public mint configuration (phase, price, supply, minted count).
 * Reads from MINT_CONFIG env var (JSON string) with safe defaults.
 * Admin: set via Vercel env vars — no secret required to read.
 */
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=30');

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Parse MINT_CONFIG env var (set in Vercel dashboard)
    // Format: JSON string — see README below for schema
    let cfg = {};
    try {
        if (process.env.MINT_CONFIG) {
            cfg = JSON.parse(process.env.MINT_CONFIG);
        }
    } catch (e) {
        console.error('[mint-config] Failed to parse MINT_CONFIG env var:', e.message);
    }

    // ── Live minted count from Vercel Blob ──
    let minted = 0;
    try {
        const { list } = await import('@vercel/blob');
        const { blobs } = await list({ prefix: 'caster101-mint/mints/', limit: 1 });
        // Each mint writes one blob; count them
        // For large collections use a counter blob instead
        const counterBlob = blobs.find(b => b.pathname === 'caster101-mint/counter.json');
        if (counterBlob) {
            const r = await fetch(counterBlob.url);
            const data = await r.json();
            minted = data.count || 0;
        }
    } catch (_) {
        // Blob not set up yet — return 0
    }

    return res.status(200).json({
        collectionName:     cfg.collectionName     || 'aWizard Caster Collection',
        phase:              cfg.phase              || 'soon',   // 'allowlist' | 'public' | 'closed' | 'soon'
        price:              cfg.price              || 'TBD',    // e.g. "5 XCH"
        priceXch:           cfg.priceXch           || null,     // numeric XCH amount for mint submission
        maxSupply:          cfg.maxSupply          || null,
        minted,
        mintgardenProfileId: cfg.mintgardenProfileId || null,
        royaltyPct:         cfg.royaltyPct         || 5,
        metadataDescription: cfg.metadataDescription || 'An aWizard Caster NFT on Chia.',
    });
}

/*
── MINT_CONFIG env var schema (set in Vercel → Settings → Environment Variables) ──

{
  "collectionName": "aWizard Casters",
  "phase": "allowlist",
  "price": "5 XCH",
  "priceXch": 5,
  "maxSupply": 777,
  "mintgardenProfileId": "YOUR_PROFILE_ID",
  "royaltyPct": 5,
  "metadataDescription": "An aWizard Caster NFT on Chia blockchain."
}

── Required Vercel env vars for full mint flow ──
  MINT_CONFIG            — JSON string above
  MINTGARDEN_API_KEY     — MintGarden creator API key
  MINT_ROYALTY_ADDRESS   — xch1... wallet for royalties
  MINT_ADMIN_SECRET      — Secret for allowlist admin endpoints
  PINATA_API_KEY         — Pinata API key (image/metadata IPFS upload)
  PINATA_SECRET_API_KEY  — Pinata secret key
  BLOB_READ_WRITE_TOKEN  — Already set for market data
*/
