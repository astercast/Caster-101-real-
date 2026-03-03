// Fetches normie stats from normies.art
export async function fetchNormieStats(normieId) {
  try {
    const indexed = await fetch(`/api/game-index?normieId=${encodeURIComponent(normieId)}`);
    if (indexed.ok) {
      const data = await indexed.json();
      if (typeof data?.hp === 'number') {
        return { hp: data.hp };
      }
    }
  } catch (_) {}

  const url = `https://www.normies.art/normiecard?id=${normieId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch normie stats');
  const html = await res.text();
  // Parse stats from HTML (simple regex for demo)
  const hpMatch = html.match(/HP:\s*(\d+)/);
  return {
    hp: hpMatch ? parseInt(hpMatch[1], 10) : 10 // fallback
  };
}
