/**
 * Cross-chain pair keys for Chia ↔ Base arbitrage (emoji market).
 * BYC (Chia) ↔ Wizard Bucks (Base) share the same bridge pair.
 */

/** Canonical bridge keys (BYC on Chia = Wizard Bucks on Base → both `wiz`). */
export const PAIRING_ALIASES = {
    byc: 'wiz',
    wiz: 'wiz'
};

/** Canonical pairing key from token id (preferred) or normalized name. */
export function pairingKey(token) {
    const id = String(token?.id || '');
    let raw = '';
    if (id.endsWith('-chia')) raw = id.slice(0, -5);
    else if (id.endsWith('-base')) raw = id.slice(0, -5);
    else raw = String(token?.name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

    return PAIRING_ALIASES[raw] || raw;
}

export function findPairedBaseToken(chiaToken, baseTokens) {
    const key = pairingKey(chiaToken);
    if (!key) return null;
    return (baseTokens || []).find(t => pairingKey(t) === key) || null;
}

export function findPairedChiaToken(baseToken, chiaTokens) {
    const key = pairingKey(baseToken);
    if (!key) return null;
    return (chiaTokens || []).find(t => pairingKey(t) === key) || null;
}

/**
 * Spread vs Chia (reference leg). Positive % = Base more expensive → buy Chia, sell Base.
 */
export function computeArbitrageSpread(chiaPrice, basePrice) {
    const chia = parseFloat(chiaPrice || 0);
    const base = parseFloat(basePrice || 0);
    if (chia <= 0 || base <= 0) {
        return {
            ok: false,
            chiaPrice: chia,
            basePrice: base,
            spreadAbs: 0,
            spreadPct: 0,
            absSpreadPct: 0,
            direction: null
        };
    }

    const spreadAbs = base - chia;
    const spreadPct = (spreadAbs / chia) * 100;

    return {
        ok: true,
        chiaPrice: chia,
        basePrice: base,
        spreadAbs,
        spreadPct,
        absSpreadPct: Math.abs(spreadPct),
        direction: spreadPct >= 0 ? 'buy_chia_sell_base' : 'buy_base_sell_chia'
    };
}

/** UI label for Chia card arb line (consistent with spreadPct). */
export function formatArbitrageLabel(spread) {
    if (!spread?.ok) {
        return { color: 'rgba(255,255,255,0.35)', icon: '⚠️', label: 'cannot fetch' };
    }
    if (spread.spreadPct > 0.05) {
        return {
            color: '#4ade80',
            icon: '🟢',
            label: `${spread.absSpreadPct.toFixed(1)}% cheaper on Chia`
        };
    }
    if (spread.spreadPct < -0.05) {
        return {
            color: '#ef4444',
            icon: '🔴',
            label: `${spread.absSpreadPct.toFixed(1)}% premium on Chia`
        };
    }
    return { color: 'rgba(255,255,255,0.3)', icon: '⚪', label: '0.0% diff' };
}
