/**
 * POST /api/mint-submit
 * Starts a mint job. Validates allowlist, calls MintGarden, returns jobId + offer.
 *
 * Body: { walletAddress: string, idempotencyKey: string }
 *
 * Flow:
 *   1. Validate address + allowlist
 *   2. Increment mint counter (atomic via Blob)
 *   3. Upload metadata JSON to IPFS (Pinata)
 *   4. Call MintGarden /mint/dynamic → returns offerFile
 *   5. Save job to Blob storage
 *   6. Return { jobId, step, offerFile }
 *
 * Required env vars:
 *   MINT_CONFIG, MINTGARDEN_API_KEY, MINT_ROYALTY_ADDRESS,
 *   PINATA_API_KEY, PINATA_SECRET_API_KEY, BLOB_READ_WRITE_TOKEN
 */

import { put, head } from '@vercel/blob';

const COUNTER_KEY  = 'caster101-mint/counter.json';
const JOBS_PREFIX  = 'caster101-mint/jobs/';

// ── Helpers ──
function isValidChiaAddress(addr) {
    return typeof addr === 'string' && /^xch1[a-z0-9]{50,}$/.test(addr);
}

async function readCounter() {
    try {
        const meta = await head(COUNTER_KEY).catch(() => null);
        if (!meta) return { count: 0 };
        const r = await fetch(meta.url, { headers: { 'Cache-Control': 'no-store' } });
        return await r.json();
    } catch { return { count: 0 }; }
}

async function incrementCounter() {
    const current = await readCounter();
    const next = { count: (current.count || 0) + 1, updatedAt: new Date().toISOString() };
    await put(COUNTER_KEY, JSON.stringify(next), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
    return next.count;
}

async function saveJob(jobId, data) {
    await put(
        `${JOBS_PREFIX}${jobId}.json`,
        JSON.stringify(data),
        { access: 'public', addRandomSuffix: false, contentType: 'application/json' }
    );
}

// ── Pinata IPFS upload ──
async function uploadMetadataToIPFS(metadata) {
    const apiKey    = process.env.PINATA_API_KEY;
    const secretKey = process.env.PINATA_SECRET_API_KEY;
    if (!apiKey || !secretKey) throw new Error('Pinata API keys not configured');

    const r = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'pinata_api_key': apiKey,
            'pinata_secret_api_key': secretKey,
        },
        body: JSON.stringify({
            pinataContent: metadata,
            pinataMetadata: { name: `caster-${metadata.edition_number || 'unknown'}.json` },
        }),
    });
    if (!r.ok) {
        const err = await r.text();
        throw new Error(`Pinata upload failed: ${err}`);
    }
    const data = await r.json();
    return data.IpfsHash;
}

// ── Placeholder image CID (replace when art is ready) ──
function getImageCid() {
    return process.env.MINT_PLACEHOLDER_IMAGE_CID || null;
}

function buildIPFSUris(cid) {
    if (!cid) return [];
    return [
        `https://gateway.pinata.cloud/ipfs/${cid}`,
        `https://ipfs.io/ipfs/${cid}`,
        `ipfs://${cid}`,
    ];
}

// ── MintGarden call ──
async function callMintGarden({ walletAddress, mintNumber, metadataCid, imageCid, cfg }) {
    const apiKey = process.env.MINTGARDEN_API_KEY;
    if (!apiKey) throw new Error('MINTGARDEN_API_KEY not set');

    const imageUris    = buildIPFSUris(imageCid);
    const metadataUris = buildIPFSUris(metadataCid);

    const royaltyAddress = process.env.MINT_ROYALTY_ADDRESS || walletAddress;
    const royaltyPct     = cfg.royaltyPct || 5;
    const priceXch       = cfg.priceXch;

    const body = {
        profile_id:         cfg.mintgardenProfileId,
        target_address:     walletAddress,
        royalty_address:    royaltyAddress,
        royalty_percentage: Math.round(royaltyPct * 100), // MintGarden uses basis points ×100
        metadata: {
            format:      'CHIP-0007',
            name:        `${cfg.collectionName || 'Caster'} #${mintNumber}`,
            description: cfg.metadataDescription || 'An aWizard Caster NFT.',
            sensitive_content: false,
            collection: {
                name: cfg.collectionName || 'aWizard Casters',
                id:   cfg.mintgardenCollectionId || undefined,
            },
            edition_number: mintNumber,
            edition_total:  cfg.maxSupply || undefined,
            attributes:     [],  // no traits — simple fixed collection
        },
        ...(imageUris.length    ? { data_uris: imageUris }             : {}),
        ...(metadataUris.length ? { metadata_uris: metadataUris }      : {}),
        ...(priceXch            ? { price: Math.round(priceXch * 1e12) } : {}), // mojos
    };

    const r = await fetch('https://api.mintgarden.io/mint/dynamic', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
    });

    if (!r.ok) {
        const text = await r.text();
        throw new Error(`MintGarden error ${r.status}: ${text}`);
    }
    return await r.json();
}

// ── Main handler ──
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    const { walletAddress, idempotencyKey } = body;

    // ── 1. Validate inputs ──
    if (!walletAddress || !isValidChiaAddress(walletAddress.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid Chia wallet address' });
    }
    const address = walletAddress.toLowerCase();

    // ── 2. Load config ──
    let cfg = {};
    try {
        if (process.env.MINT_CONFIG) cfg = JSON.parse(process.env.MINT_CONFIG);
    } catch {}

    if (cfg.phase === 'closed' || cfg.phase === 'soon' || !cfg.phase) {
        return res.status(403).json({ error: 'Mint is not open' });
    }

    // ── 3. Allowlist check ──
    if (cfg.phase === 'allowlist') {
        const r = await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/mint-allowlist?address=${encodeURIComponent(address)}`);
        const data = await r.json();
        if (!data.approved) {
            return res.status(403).json({ error: 'Not on the allowlist' });
        }
    }

    // ── 4. Supply check ──
    if (cfg.maxSupply) {
        const counter = await readCounter();
        if (counter.count >= cfg.maxSupply) {
            return res.status(400).json({ error: 'Sold out' });
        }
    }

    // ── 5. Increment counter → get mint number ──
    let mintNumber;
    try {
        mintNumber = await incrementCounter();
    } catch (e) {
        console.error('[mint-submit] counter error', e);
        return res.status(500).json({ error: 'Failed to reserve mint number' });
    }

    const jobId = `${Date.now()}-${mintNumber}`;

    // ── 6. Save initial job ──
    await saveJob(jobId, {
        jobId,
        step: 'uploading_ipfs',
        address,
        mintNumber,
        startedAt: new Date().toISOString(),
        idempotencyKey: idempotencyKey || null,
    });

    // ── 7. Upload metadata to IPFS ──
    let metadataCid = null;
    try {
        const metadata = {
            format:           'CHIP-0007',
            name:             `${cfg.collectionName || 'Caster'} #${mintNumber}`,
            description:      cfg.metadataDescription || 'An aWizard Caster NFT.',
            sensitive_content: false,
            collection: {
                name: cfg.collectionName || 'aWizard Casters',
                id:   cfg.mintgardenCollectionId || undefined,
            },
            edition_number: mintNumber,
            edition_total:  cfg.maxSupply || undefined,
            attributes:     [],
        };
        metadataCid = await uploadMetadataToIPFS(metadata);
    } catch (e) {
        console.error('[mint-submit] IPFS error', e);
        await saveJob(jobId, { jobId, step: 'failed', error: e.message, address, mintNumber });
        return res.status(500).json({ error: 'IPFS upload failed: ' + e.message });
    }

    await saveJob(jobId, { jobId, step: 'generating_offer', address, mintNumber, metadataCid });

    // ── 8. Call MintGarden ──
    let mintResult;
    try {
        mintResult = await callMintGarden({
            walletAddress: address,
            mintNumber,
            metadataCid,
            imageCid: getImageCid(),
            cfg,
        });
    } catch (e) {
        console.error('[mint-submit] MintGarden error', e);
        await saveJob(jobId, { jobId, step: 'failed', error: e.message, address, mintNumber });
        return res.status(500).json({ error: 'MintGarden error: ' + e.message });
    }

    // ── 9. Save awaiting_payment state ──
    const offerFile     = mintResult.offer         || mintResult.offerFile     || null;
    const launcherId    = mintResult.launcher_id   || mintResult.launcherId    || null;
    const mintgardenUrl = mintResult.mintgarden_url || mintResult.mintgardenUrl || (launcherId ? `https://mintgarden.io/nfts/${launcherId}` : null);

    await saveJob(jobId, {
        jobId, step: 'awaiting_payment',
        address, mintNumber, metadataCid, offerFile, launcherId, mintgardenUrl,
        startedAt: new Date().toISOString(),
    });

    return res.status(200).json({
        jobId,
        step:        'awaiting_payment',
        mintNumber,
        offerFile,
        launcherId,
        mintgardenUrl,
    });
}
