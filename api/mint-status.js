/**
 * GET /api/mint-status?jobId=xxx&address=xch1...
 * Returns current state of a mint job.
 *
 * Response: { jobId, step, stepLabel, mintNumber?, offerFile?, mintgardenUrl?, error? }
 *
 * Step values (in order):
 *   queued → validating → uploading_ipfs → generating_offer → awaiting_payment → completed | failed
 */

import { head } from '@vercel/blob';

const JOBS_PREFIX = 'caster101-mint/jobs/';

const STEP_LABELS = {
    queued:           'Queued',
    validating:       'Validating…',
    uploading_ipfs:   'Uploading to IPFS…',
    generating_offer: 'Generating offer…',
    awaiting_payment: 'Awaiting payment',
    completed:        'Completed',
    failed:           'Failed',
};

async function readJob(jobId) {
    // Sanitize jobId to prevent path traversal
    if (!jobId || !/^[\w-]+$/.test(jobId)) return null;
    try {
        const blobPath = `${JOBS_PREFIX}${jobId}.json`;
        const meta = await head(blobPath).catch(() => null);
        if (!meta) return null;
        const r = await fetch(meta.url, { headers: { 'Cache-Control': 'no-store' } });
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { jobId, address } = req.query;
    if (!jobId) return res.status(400).json({ error: 'jobId required' });

    const job = await readJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Only return job to the address that requested it
    // (soft privacy — not a security guarantee, NFT is already on-chain)
    if (address && job.address && address.toLowerCase() !== job.address) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    return res.status(200).json({
        jobId:         job.jobId,
        step:          job.step,
        stepLabel:     STEP_LABELS[job.step] || job.step,
        mintNumber:    job.mintNumber    || null,
        offerFile:     job.offerFile     || null,
        mintgardenUrl: job.mintgardenUrl || null,
        error:         job.error         || null,
        startedAt:     job.startedAt     || null,
    });
}
