# Caster101 — Pricing Pipeline Architecture

## Chia CAT Price Flow

```
Browser fetchChiaData()
  │
  ├─ CoinGecko proxy (/api/coingecko-proxy) → XCH/USD
  ├─ Dexie /v2/prices/tickers → last_price × XCH/USD (only if base_volume > 0)
  ├─ /api/chia-cat-prices → server batch (Dexie + Spacescan parallel)
  └─ Spacescan /cat/info/{assetId} (browser-direct, bypasses Vercel 403s) → supply
  
Server /api/chia-cat-prices
  ├─ CoinGecko → XCH/USD
  ├─ Dexie tickers (all CATs, one call)
  ├─ Spacescan parallel calls (best-effort, may 403)
  └─ Dexie best-ask fallback for stale/missing prices

Market cap = circulating_supply × price
  supply priority: Spacescan → STATIC_SUPPLY_FALLBACKS → browser Spacescan direct
```

**Dexie stale rule**: If `base_volume === 0`, last_price is unreliable. Fall to best-ask endpoint.

## Base Token Price Flow

```
Browser fetchBaseData()
  │
  ├─ DexScreener batch /tokens/v1/base/{all_contracts}  ← INCOMPLETE (subset only)
  ├─ DexScreener per-token /latest/dex/tokens/{ca}      ← RELIABLE (for every token)
  ├─ GeckoTerminal /tokens/multi/{contracts}             ← GAPS ONLY (never overwrites Dex)
  └─ GeckoTerminal /tokens/{ca}/pools                    ← for tokens with 0 Dex pairs (Pizza, etc.)

mergeBasePairsIntoMap(pairs, contractSet, out)
  - Considers token as BASE or QUOTE side of pair
  - Price from highest-liquidity pool
  - dexMcap from any pool where token is base side

resolveBaseMarketCap({ gtSupply, price, dexMcap, impliedSupply, geckoMcap })
  Priority: dexMcap → geckoMcap → impliedSupply×price → gtSupply×price
  Band check: candidates within 0.25x–4x of anchor are preferred

Standard quote filter (market-index.js): WETH, USDC, ETH, USDT, WXCH, XCH only
  (base-dex-pairs.js uses all quotes including ecosystem CATs for richer pricing)
```

## market-index.js Snapshot

```
GET /api/market-index
  1. Check memory cache (1 min TTL) → return immediately if fresh
  2. Load from @vercel/blob (caster101-index/market-v2.json)
     - If blob age > 10 min → trigger SWR background rebuild, return stale
     - If blob fresh → return blob
  3. Build fresh snapshot:
     - fetchAllBaseTokens(): DexScreener batch → per-token fallback → GT mcap fill
     - /api/coingecko-proxy → XCH/USD
     - /api/chia-cat-prices → all Chia prices/changes/mcaps
  4. Save to blob + memory cache

POST /api/market-index
  - Browser pushes its live data (after fetchChiaData + fetchBaseData complete)
  - Must have ≥1 priced Chia CAT + non-empty base array
  - Saved to memory + blob so next visitor gets fresh data instantly
```

## Arbitrage Flow

```
GET /api/arbitrage
  1. GET /api/market-index → token registry (ids, assetIds, contracts)
  2. Parallel:
     - Dexie /v2/prices/tickers → Chia live prices
     - DexScreener batch → Base live prices (std quotes only)
     - CoinGecko → XCH/USD
  3. Build pairing maps:
     - pairingKey(token): strip -chia/-base suffix; apply PAIRING_ALIASES
     - byc-chia → key "wiz"; wiz-base → key "wiz" (both match)
  4. For each matched pair: compute spread
     spreadPct = (basePrice − chiaPrice) / chiaPrice × 100
  5. Filter by minSpreadPct, sort descending by absSpreadPct

index.html arbitrage UI
  - arbPairingKey(token): same logic as server pairingKey
  - findPairedBaseForChia(chiaToken, baseList)
  - computeArbSpread(chiaPrice, basePrice) → { ok, spreadPct, absSpreadPct }
  - arbUiFromSpread(spread) → { color, icon, label }
  - sortTokens('arbitrage'): pairs Chia tokens with Base, sorts by absSpreadPct
```

## Key API Endpoints (external)

| Service | Endpoint | Use |
|---------|----------|-----|
| Dexie tickers | `GET https://dexie.space/v2/prices/tickers` | All Chia CAT prices |
| Dexie offers | `GET https://dexie.space/v1/offers?offered={id}&requested=xch` | Best-ask fallback |
| Spacescan | `GET https://api.spacescan.io/cat/info/{assetId}` | Supply + price (blocks Vercel) |
| DexScreener batch | `GET https://api.dexscreener.com/tokens/v1/base/{ca1,ca2,...}` | Base prices (incomplete) |
| DexScreener per-token | `GET https://api.dexscreener.com/latest/dex/tokens/{ca}` | Base price (reliable) |
| GeckoTerminal multi | `GET https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/{ca1,...}` | Token attrs/supply |
| GeckoTerminal pools | `GET https://api.geckoterminal.com/api/v2/networks/base/tokens/{ca}/pools` | Pools for unpriced tokens |
| CoinGecko (via proxy) | `/api/coingecko-proxy?ids=chia&vs_currencies=usd` | XCH/USD |
| xchscan | `GET https://xchscan.com/api/chia-price` | XCH/USD fallback |

## Vercel Blob Cache
- Key: `caster101-index/market-v2.json`
- Library: `@vercel/blob` (`put`, `head`)
- Access: public (readable by browser)
- `allowOverwrite: true`, `addRandomSuffix: false`

## Treasury Pipeline

```
GET /api/treasury-index
  1. Memory cache (2 min) → return
  2. Blob (caster101-index/treasury.json)
     - No CATs? → serve partial + SWR rebuild
     - Age > 30 min? → SWR rebuild, return stale
  3. buildSnapshot():
     - POST /api/treasury-comprehensive?chain=base&address={W1}
     - POST /api/treasury-comprehensive?chain=base&address={W2}
     - POST /api/chia-cat-prices?mode=treasury&wallets={W1,W2,W3}
     - /api/coingecko-proxy → XCH/USD
     - Merge Base tokens (LP kept separate), merge Chia by assetId
     - buildNftCollections() groups by collection_id

POST /api/treasury-index (browser push)
  - Must have ≥1 non-native Chia CAT and non-empty baseData
  - NFT data preserved from prior blob if server rebuild gets 0 NFTs

/api/treasury-comprehensive?chain=base&address=0x...
  - Blockscout ERC20 list → exchange_rate prices → DexScreener for missing
  - LP detection: sym contains -LP, UNI-V2, 9MM-LP, LIQUIDITY
  - LP valuation: RPC batch (token0, token1, getReserves, totalSupply, decimals)
    - RPCs: publicnode, llamarpc, meowrpc (round-robin on failure)
  - GT fallback for unpriced LP underlying tokens

/api/treasury-comprehensive?chain=chia&address=xch1...&type=tokens
  - Spacescan xch-balance (fast) + token-balance (25s, single attempt)
  - 429 → returns XCH only

/api/treasury-comprehensive?chain=chia&address1=W1&address2=W2&type=full
  - Sequential W1 tokens → 2s sleep → W2 tokens (rate limit avoidance)
  - Both wallets NFTs in parallel
  - MintGarden enrichment (batches of 8)
```

## Mint Pipeline

```
GET /api/mint-config
  → reads MINT_CONFIG env var (JSON) + counts minted from blob counter

GET /api/mint-allowlist?address=xch1...
  → reads caster101-mint/allowlist.json from blob
  → phase=public: always approved
  → phase=closed/soon: never approved

POST /api/mint-allowlist (admin)
  → Authorization: Bearer <MINT_ADMIN_SECRET>
  → actions: add | bulk_add | remove | list | clear
  → writes caster101-mint/allowlist.json

POST /api/mint-submit
  → uploads image to Pinata IPFS
  → creates metadata JSON on IPFS
  → calls MintGarden creator API to mint NFT
  → increments caster101-mint/counter.json
```

## Caster Valley Backend

```
GET/POST /api/caster-valley-save?deviceId={id}
  → Upstash KV: cv:save:{deviceId}
  → GET: returns { ok, save: {...} }
  → POST: writes save data (max 500KB)

GET/POST /api/caster-valley-leaderboard
  → Upstash KV: cv:leaderboard = { [deviceId]: entry }
  → GET: returns sorted top 50 by totalEssenceEarned
  → POST: upsert with score-only-going-up rule

GET /api/game-index?normieId={id}
  → Scrapes normies.art HTML → parses HP stat
  → Memory cache 5min, blob per normie
```

## Debug Tips
- Add `?refresh=1` to `/api/market-index` to force a snapshot rebuild
- Check Vercel function logs for `[market-index]`, `[emoji-market]` log prefixes
- `sources` field in `/api/chia-cat-prices` response shows which source priced each token
- DexScreener rate limit: 300ms delay between per-token calls in live-base-prices.js
