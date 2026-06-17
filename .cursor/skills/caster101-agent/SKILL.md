---
name: caster101-agent
description: Expert Caster101 development agent. Full knowledge of the entire site — emoji market, arbitrage, treasury, Caster Valley game, leaderboard, cloud saves, mint system, NFT pipeline, all API routes, token registry, and pricing pipeline. Use when building any feature, fixing prices, editing game logic, adding tokens, modifying treasury display, or working on the mint flow. Never needs to re-read files for baseline knowledge.
---

# Caster101 Agent

The always-apply rule (`caster101-context.mdc`) has everything loaded: token registry, all API routes, game system, treasury wallets, mint env vars, pricing pipeline, and key gotchas. Use it — don't re-read files unless you need line-level detail.

For complete reference: [TOKENS.md](TOKENS.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [GAME.md](GAME.md)

---

## Workflows by domain

### Adding a new token
Edit in this order (all 7 locations):
1. `api/market-index.js` → `TRACKED.chia` or `TRACKED.base`
2. `api/chia-cat-prices.js` → `CAT_IDS` (Chia only)
3. `api/prices.js` → `TOKEN_ALIASES`
4. `index.html` → `trackedTokens`
5. `index.html` → `EMOJI_MAP`
6. `index.html` → `TANG_NAMES` (if meme/degen)
7. Bridge pair with different name → `PAIRING_ALIASES` in `api/token-pairing.js` + `ARB_PAIR_ALIASES` in `index.html`

### Fixing wrong prices
- **Chia wrong** → check Dexie ticker `base_volume`; if 0, last_price is stale → falls to best-ask
- **Base wrong** → DexScreener batch is incomplete; per-token is the fix (`api/base-dex-pairs.js`)
- **Mcap wrong (Chia)** → supply × price. Supply from Spacescan (may 403 Vercel) → static fallback → browser-direct
- **Mcap wrong (Base)** → `resolveBaseMarketCap` in `api/base-dex-pairs.js`: dex fdv → gecko fdv → implied → gecko supply×price
- **Pizza/low-liquidity Base tokens** → Gecko pools path in `fetchBaseData` / `api/live-base-prices.js`

### Fixing arbitrage
- Spread: `(basePrice − chiaPrice) / chiaPrice × 100`
- Positive = base more expensive → buy Chia
- Pairing: strip `-chia`/`-base` from token `id`. BYC exception: `byc → wiz`
- Both `api/arbitrage.js` and `index.html` `computeArbSpread`/`arbPairingKey` must match
- If a pair is missing: verify both tokens have the same canonical key and non-zero live prices

### Emoji market UI
Key functions in `index.html`:
- `updateEmojiMarket(chiaTokens, baseTokens)` — renders both columns
- `createChiaCard(token)` — Chia card with arbitrage line
- `createBaseCard(token)` — Base card
- `sortTokens(by)` — `'arbitrage'` sort pairs by `findPairedBaseForChia`
- `fetchChiaData(baseData)` — live prices + supplies
- `fetchBaseData()` — live Base prices

### Caster Valley game
See [GAME.md](GAME.md) for full mechanics. Key hooks:
- Save/load: `localStorage` key `castervalleys1` + cloud via `POST /api/caster-valley-save`
- Cloud load: compare `savedAt` → use whichever is newer
- Leaderboard: `POST /api/caster-valley-leaderboard` with `{ deviceId, name, level, totalEssenceEarned }`
- Save migrations: `SAVE_MIGRATIONS` object (current `SAVE_VERSION = 2`)
- Normie stat fetch: `GET /api/game-index?normieId={id}`

### Treasury
- Wallets hardcoded in `api/treasury-index.js` (2 Base + 3 Chia addresses)
- Snapshot: `GET /api/treasury-index` (mem 2min, blob SWR 30min)
- Push fresh data: `POST /api/treasury-index` with `{ baseData, chiaData, nftData }`
- Per-wallet: `GET /api/treasury-comprehensive?chain=base&address=0x...` or `?chain=chia&address=xch1...&type=tokens|nfts|full`
- LP valuation: RPC batch calls (token0, token1, getReserves, totalSupply) against Base RPC endpoints
- NFTs: Spacescan + MintGarden enrichment. Server can't fetch NFTs (Spacescan blocks Vercel) → must come from browser POST
- Adding a wallet → edit `BASE_WALLET_*` / `CHIA_WALLET_*` constants in `treasury-index.js`

### Mint system
- Phase controlled by `MINT_CONFIG` env var (JSON in Vercel dashboard)
- Check allowlist: `GET /api/mint-allowlist?address=xch1...`
- Manage allowlist (admin): `POST /api/mint-allowlist` with `Authorization: Bearer <MINT_ADMIN_SECRET>`
  - Actions: `add`, `bulk_add`, `remove`, `list`, `clear`
- Mint counter in blob: `caster101-mint/counter.json` → `{ count: N }`
- Phases: `allowlist` | `public` | `closed` | `soon`

### Snapshot / cache
- Market: `GET /api/market-index` → mem(1min) → blob → SWR rebuild. Force: `?refresh=1`
- Treasury: `GET /api/treasury-index` → mem(2min) → blob → SWR rebuild. Force: `?refresh=1`
- Both endpoints accept `POST` from browser to push live data

---

## Common patterns

```js
// Token id format
{ id: 'mytoken-chia', symbol: '🪙', name: 'MyToken', chain: 'Chia', assetId: '64_hex' }
{ id: 'mytoken-base', symbol: '🪙', name: 'MyToken', chain: 'Base', contract: '0xADDRESS' }

// Bridge pair alias (both sides → same canonical key)
PAIRING_ALIASES = { oldname: 'canonical', canonical: 'canonical' }

// Spread calculation
const spreadPct = (basePrice - chiaPrice) / chiaPrice * 100;
// > 0.05 → 🟢 cheaper on Chia
// < -0.05 → 🔴 premium on Chia

// Leaderboard entry (never decrements score)
lb[deviceId] = {
  deviceId, name, level,
  totalEssenceEarned: Math.max(newValue, existing?.totalEssenceEarned || 0),
  updatedAt: Date.now()
}

// Mint config object
{
  collectionName, phase, price, priceXch, maxSupply,
  mintgardenProfileId, royaltyPct, metadataDescription
}
```
