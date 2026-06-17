# Caster Valley — Complete Game Reference

## Overview
Browser-based cozy farming/crafting game. Loaded in an iframe at the `valley` tab.
File: `caster-valley-3d.html` (self-contained, ~6100 lines)
Direct URL: `https://caster101.xyz/valley`

There is also a **secret game** (`awizard-game.html`) accessed by clicking the "CASTER101" title on the homepage.

---

## Save System

### Local save
- Key: `localStorage.castervalleys1`
- Auto-saved every 10 seconds via `setInterval`
- Also saved on major actions

### Cloud save
- API: `GET /api/caster-valley-save?deviceId={id}` → `{ ok, save }`
- API: `POST /api/caster-valley-save` body `{ deviceId, save }` → `{ ok }`
- Backend: Upstash Redis KV key `cv:save:{deviceId}`
- Max payload: 500,000 bytes
- `save.savedAt` is set server-side if not in body
- On load: compare cloud `savedAt` vs local `savedAt` → use newer

### Device ID
- Generated on first run, stored in localStorage
- Persists across sessions on same device

### Save migrations
```js
const SAVE_VERSION = 2;
const SAVE_MIGRATIONS = {
  1: (save) => { /* add fishFedToDragon stat */ return save; },
  2: (save) => { /* ensure stats object */ return save; }
};
function migrateSave(save) { /* runs all needed migrations */ }
```

---

## Game State Object (key fields)

```js
{
  deviceId, essence, hp, maxHP, level, xp, xpNeeded,
  plantSpeed, baseDamage, hpRegen, essenceMult, extraPlots, fishLuck,
  stats: { fishFedToDragon, ... },
  version: 2
}
```

---

## Skill Tree (Bounties)
| id | Name | Cost (SP) | Effect |
|----|------|-----------|--------|
| bounty1 | Bounty I | 120 | +25% SP from all sources |
| bounty2 | Bounty II | 350 | +25% SP total (req: bounty1) |
| bounty3 | Bounty III | 900 | +30% SP total (req: bounty2) |
| bounty4 | Bounty IV | 2500 | +40% SP total (req: bounty3) |
| bounty5 | Bounty V | 6000 | +50% SP total (req: bounty4) |

---

## Achievements
| id | Name | Desc | SP Reward |
|----|------|------|-----------|
| apprentice | Apprentice | Reach level 5 | 120 |
| skilled_wizard | Skilled Wizard | Reach level 12 | 500 |
| archmage | Archmage | Reach level 25 | 2500 |

---

## Leaderboard

**API:**
- `GET /api/caster-valley-leaderboard` → `{ ok, entries: [{ deviceId, name, level, totalEssenceEarned, updatedAt }] }` (top 50)
- `POST /api/caster-valley-leaderboard` body `{ deviceId, name, level, totalEssenceEarned }` → `{ ok }`

**Rules:**
- Score (`totalEssenceEarned`) never decrements — server takes `Math.max(new, existing)`
- Name max 20 chars, `<>"` stripped
- Level capped 1–999
- Sorted descending by `totalEssenceEarned`
- KV key: `cv:leaderboard` = JSON object `{ [deviceId]: entry }`

**In-game:** Trophy button opens leaderboard modal. Player enters a name before submitting score.

---

## Normie Integration

`/api/game-index?normieId={id}` scrapes `https://www.normies.art/normiecard?id={id}` HTML and parses:
- `HP: {N}` → `{ hp: N }` (default 10 if not found)
- Cached per normieId: memory 5min, blob `caster101-index/game/normie-{id}.json`
- Force refresh: `?refresh=1`

---

## UI Modals in Game
- `leaderboard` — trophy button (🏅) opens leaderboard, player can submit name + score
- Skill tree, inventory, crafting — accessed via in-game menu buttons

---

## Day/Night Cycle
- `body.classList.toggle('night-mode')` — CSS handles the gradient transition (`1.5s ease`)
- `night-mode` CSS: `background: linear-gradient(180deg, #1a1a3e 0%, #0f1a2e 100%)`

---

## Common Game Tasks

### Adding a new skill tree node
1. Add to `SKILL_TREE` array in `caster-valley-3d.html`
2. Fields: `{ id, name, desc, cost, stat, value, icon, x, y, requires: [] }`

### Adding a new achievement
1. Add to `ACHIEVEMENTS` array
2. Fields: `{ id, name, desc, icon, reward, check: g => boolean }`

### Adding a new save field
1. Add default value to the initial game state object
2. Add migration to `SAVE_MIGRATIONS[SAVE_VERSION]` (increment `SAVE_VERSION`)
3. Initialize in `migrateSave` if needed

### Editing leaderboard behavior
- `api/caster-valley-leaderboard.js` — KV is `cv:leaderboard`
- Score logic: `Math.max(Math.floor(parsedEssence), existing?.totalEssenceEarned || 0)`
- Top 50 only returned to clients

### Cloud save issues
- If Upstash KV not configured → `KV_URL`/`KV_TOKEN` env vars missing → `kvCmd` throws `KV not configured`
- Save payload > 500KB → 413 error
- Check env vars: `KV_REST_API_URL`, `KV_REST_API_TOKEN`
