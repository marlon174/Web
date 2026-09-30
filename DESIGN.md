# Landgrab design

Landgrab keeps the one mechanic that makes territorial.io work: a single troop count that grows on its own, spent by sending a share of it across your border. Frontwars-style depth (terrain, buildings, boats, alliances) layers on top later.

## Rules as built

| Rule | How it works | Where |
|---|---|---|
| Map | Grid of tiles: water, plains, highlands, mountains. One continent from seeded noise; land not joined to it is sunk because nobody can cross water yet. | `src/core/map.ts` |
| Troops | Each tick: `troops × interest × (1 − troops/cap) + tiles × landIncome`. Cap = `tiles × 100`. Above the cap, troops slowly desert. | `grow()` in `game.ts` |
| Expanding | Clicking empty land sends a share of your troops into all neutral land along your border. Each tile costs `2 × terrain` troops. | `launch()`, `advance()` |
| Attacking | Same, into one neighbour. Each tile costs `(2 + 2 × their troops per tile) × terrain`; they lose one tile's worth of troops. Two players attacking each other clash first and cancel out. | `launch()`, `tileCost()` |
| Fronts | Each attack keeps a priority queue of target tiles keyed by the tick they fall. Terrain slows it, tiles surrounded on more sides fall sooner, and a little seeded randomness keeps fronts organic. | `enqueue()`, `heap.ts` |
| Capitals | Losing yours halves your troops; a new one is chosen near the middle of your land. | `loseCapital()` |
| Encirclement | Every second, land cut off by exactly one player changes hands: enemy fragments without their capital, and small neutral pockets. | `sweepEnclosures()` |
| Winning | Quick match: most land after 5 minutes. Classic: 80% of the land, or last one standing. | `checkEnd()` |
| Gold | Each tile earns gold every tick. | `grow()` |
| Buildings | City: +20% troop cap. Defence post: land within 8 tiles costs attackers 2× and falls slower. Silo: launches missiles. Each one you own raises the next one's price. Buildings change hands with their tile. | `canBuild()`, `conquer()` |
| Missiles | Rocket (radius 5) and nuke (radius 12) fly from your nearest silo. On impact land turns neutral, buildings are destroyed, owners lose troops, and a hit capital counts as lost. Fallout: bombed land isn't absorbed as a pocket and costs double for 30 s. | `fireMissile()`, `impact()` |
| Bots | Expand while there is empty land; once nearly full, attack the neighbour with the thinnest defences. Difficulty sets reaction time and thresholds. | `bots.ts` |

All numbers live in `src/core/config.ts` and `bots.ts`. `npm run sim` replays a bots-only match in the terminal to check pacing after a change.

## Architecture: ready for lockstep multiplayer

The simulation in `src/core` is **deterministic**: the same settings plus the same intents on the same ticks always produce the same game.

- Randomness comes only from a seeded generator (`rng.ts`). No `Math.random`, clocks or DOM in the core, and only basic arithmetic (no `Math.sin`/`exp`/`pow`, whose results can differ between browsers).
- Players act through **intents** (`spawn`, `attack`), queued and applied at the start of the next tick. Bots run inside the simulation, so they need no network traffic.
- `game.log` records every human intent with its tick, which is enough to replay a match. `game.hash()` digests the state to detect clients drifting apart.

For multiplayer, a server only has to collect intents, stamp them with a tick and relay them to every client. Each client runs the same simulation. Bandwidth stays tiny whatever the map size.

The client (`src/client`) draws the map as one pixel per tile on an offscreen canvas, repaints only changed tiles, and scales it up with the camera. Territory labels sit at the point farthest from any border, found with a distance transform every 300 ms.

## Performance

About 0.3 ms per tick on a 480×300 map with 12 bots, ticking 10 times a second. The encirclement sweep is the heaviest step at a few milliseconds once a second.

## Balance check

Scripted "competent human" (2-second reactions, expands while it can, attacks the weakest neighbour when nearly full) against 7 bots on 10 quick-match maps:

| Bots | Human wins | Average place |
|---|---|---|
| Easy | 10 / 10 | 1.0 |
| Normal | 8 / 10 | 1.5 |
| Hard | 5 / 10 | 2.9 |

Neutral land runs out after 60 to 120 seconds; classic matches last 7 to 15 minutes.

## Roadmap

| Phase | Goal | Status |
|---|---|---|
| 1. Single-player MVP | Map, spawning, troop growth, attacks, bots, rendering, send slider | **Done**, plus capitals, quick match and the colour picker |
| 2. Multiplayer | Lobby server, lockstep tick relay, desync checks via `hash()`, reconnection | Next |
| 3. Frontwars layer | Gold, cities, defence posts, silos, rockets and nukes **done**. Still to come: ports and boats, alliances, real-world maps | In progress |
| 4. Polish | Minimap, sound, replays from `game.log`, tutorial match | Planned |

## Idea backlog

Done: capital tile, quick match, colour picker.

Still open, roughly in order of cost:

- **Emotes**: a few fixed icons instead of chat, nothing to moderate.
- **Daily challenge**: same seed and bots for everyone, leaderboard for the fastest win. Seeds already drive everything.
- **Replay sharing**: a link that replays a whole match from its intent log.
- **Tutorial bot match**: two guided minutes on expanding, attacking and holding troops back.
- **Truce button**: a short no-attack pact with a neighbour; breaking it early costs troops.
- **Teams (2v2, 4v4)**: shared borders, sending troops to allies.
- **Map events**: gold rush (cheaper land), storms (no boats).
- **Rebellions**: huge empires occasionally lose a border region to neutral.
- **Fog of war**: optional mode where you only see near your borders.
- **Battle royale**: the playable map shrinks over time.
