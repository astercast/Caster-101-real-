# 🧙‍♂️
https://casterx101.vercel.app/

## Market Index (Blob Cache)

- Added `api/market-index.js` to precompute and cache Base + Chia market data snapshots.
- Added `api/treasury-index.js` to precompute/cache treasury + NFT snapshot for fast tab load.
- Added `api/game-index.js` to cache game Normie stat lookups.
- Requires `BLOB_READ_WRITE_TOKEN` in Vercel project env vars to persist snapshots to Vercel Blob.
- If Blob is unavailable, endpoint still works with safe in-memory fallback (no site breakage).
