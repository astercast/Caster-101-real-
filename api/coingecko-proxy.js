// coingecko-proxy.js — Vercel API route
// Proxies CoinGecko simple price requests to avoid browser CORS issues.

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const params = req.query || {};
        const ids = params.ids || 'chia';
        const vs = params.vs_currencies || 'usd';
        const includeChange = params.include_24hr_change ? 'true' : 'false';
        const includeMcap = params.include_market_cap ? 'true' : 'false';

        const url = new URL('https://api.coingecko.com/api/v3/simple/price');
        url.searchParams.set('ids', ids);
        url.searchParams.set('vs_currencies', vs);
        url.searchParams.set('include_24hr_change', includeChange);
        url.searchParams.set('include_market_cap', includeMcap);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            return res.status(response.status).json({ error: `CoinGecko returned ${response.status}` });
        }

        const data = await response.json();
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
