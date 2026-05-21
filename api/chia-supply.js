/** Parse circulating/total supply from Spacescan cat/info payload. */
export function parseChiaCatSupply(data = {}) {
    const circ = parseFloat(data.circulating_supply || 0);
    if (circ > 0) return circ;

    const total = parseFloat(data.total_supply || 0);
    if (total > 0) return total;

    const issued = data.issued || data.issued_coins;
    if (Array.isArray(issued) && issued.length) {
        const sum = issued.reduce((s, c) => s + parseFloat(c?.amount || c?.value || 0), 0);
        if (sum > 0) return sum;
    }

    return 0;
}
