// Fetches normie stats from normies.art
export async function fetchNormieStats(normieId) {
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
