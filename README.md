# Caster101

Live site: https://caster101.xyz/

## Current Site Scope

- Single-page community portal with tabs for:
	- Emoji Market
	- Bag (portfolio)
	- aWizard Treasury
	- How To Cast
	- Book of Wizard
	- Caster Valley
- Floating WTV miniplayer/drawer with Google Drive playlist support.
- Book of Wizard links are in a 2x4 grid (desktop + mobile), including aWizard, Discord, MintGarden links, Follow on X, and Spotify.
- Dynamic background collage/animation system drawing from `images/` assets.

## API + Caching

- `api/market-index.js` precomputes/caches Base + Chia market snapshots.
- `api/treasury-index.js` precomputes/caches treasury + NFT snapshots.
- `api/game-index.js` caches game Normie stat lookups.
- `BLOB_READ_WRITE_TOKEN` is required in Vercel env vars for persistent Blob caching.
- If Blob is unavailable, APIs fall back safely in-memory.

## Deployment

- Hosted on Vercel.
- Pushes to `main` trigger deploys.
- Domain migration target is `caster101.xyz`.
