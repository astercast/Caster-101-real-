export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // counterapi.dev — free, persistent, atomic hit counter
        const apiRes = await fetch(
            'https://api.counterapi.dev/v1/caster101/pageviews/up',
            { headers: { 'Accept': 'application/json' } }
        );
        if (!apiRes.ok) throw new Error(`counterapi ${apiRes.status}`);
        const data = await apiRes.json();
        // Returns { count: <number> }
        res.status(200).json({ count: data.count });
    } catch (err) {
        console.error('visitor-count error:', err);
        // Return null so frontend keeps its placeholder
        res.status(200).json({ count: null });
    }
}
