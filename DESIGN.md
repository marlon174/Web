# Landgrab design

Landgrab keeps the one mechanic that makes territorial.io work: a single troop count that grows on its own, spent by sending a share of it across your border. Frontwars-style depth (terrain, buildings, boats, alliances) layers on top later.

## Rules as built

| Rule | How it works | Where |
|---|---|---|
| Map | Grid of tiles: water, plains, highlands, mountains. One continent from seeded noise; land not joined to it is sunk because nobody can cross water yet. | `src/core/map.ts` |
| Troops | Each tick: `troops × interest × (1 − troops/cap) + tiles × landIncome`. Cap = `tiles × 100`. Above the cap, troops slowly desert. | `grow()` in `game.ts` |
| Expanding | Clicking empty land sends a share of your troops into all neutral land along your border. Each tile costs `2 × terrain` troops. | `launch()`, `advance()` |
| Attacking | Same, into one neighbour. Each tile costs `(2 + 2 × their troops per tile) × terrain`; they lose one tile's worth of troops. Two players attacking each other clash first and cancel out. | `launch()`, `tileCost()` |
| Terrain | Per tile by terrain class: plains 2 ticks / 1×, hills 4 ticks / 1.6×, mountains 9 ticks / 2.8×, all divided by `troopSpeed` (1.21). Tiles an attack can't afford are skipped, not fatal. Maps colour terrain by class (green, brown, grey rock with snow) with a dark rim where ground steps up. | `enqueue()`, `tileCost()` |
| Fronts | Each attack keeps a priority queue of target tiles keyed by the tick they fall. Terrain slows it, tiles surrounded on more sides fall sooner, and a little seeded randomness keeps fronts organic. | `enqueue()`, `heap.ts` |
| Capitals | Losing yours halves your troops; a new one is chosen near the middle of your land. | `loseCapital()` |
| Encirclement | Every second, land cut off by exactly one player changes hands: enemy fragments without their capital and not touching the sea (coastal land, such as a beachhead, is supplied by water), and small neutral pockets. | `sweepEnclosures()` |
| Winning | Quick match: most land after 5 minutes. Classic: 70% of the land, or last one standing. | `checkEnd()` |
| Gold | Each tile earns gold every tick. | `grow()` |
| Buildings | City: +20% troop cap. Bunker (defence post): land within 12 tiles costs attackers 3.5×, falls 6 ticks slower per tile, and its owner loses only half the usual troops there. Overrunning a bunker destroys it; other buildings change hands. Silo: launches missiles. Each one you own raises the next one's price. Buildings change hands with their tile. | `canBuild()`, `conquer()` |
| Missiles | Rocket (radius 5) and nuke (radius 16) fly from your nearest silo. On impact land turns neutral, buildings are destroyed, owners lose troops, and a hit capital counts as lost. Fallout: bombed land isn't absorbed as a pocket and costs double for 30 s. | `fireMissile()`, `impact()` |
| Prices and limits | `cost + step × owned`, capped at `max` per kind. Each player may build 2 of a kind plus one per N tiles of land (cities 2,500, bunkers 1,500, ports 4,000, silos 6,000, factories 8,000). Cities add +20% troop cap each, +100% at most. Each city or port pays a train at most once a minute. Silos reload for 10 s after each launch. | `buildCost()`, `buildLimit()` |
| Trains | A factory's rail runs to up to 6 of its owner's cities and ports within 60 tiles, nearest-neighbour order. One train per factory per minute; +10K gold per city/port passed. | `railRoute()`, `updateTrains()` |
| Boats | Ports sit on the coast. A boat's route is a breadth-first search over water from the beach back to one of your ports; on arrival the troops take the beach and attack inland from it. Max 3 at sea. The map keeps islands (80+ tiles); bots always start on the continent. | `planBoat()`, `land()` |
| Alliances | Offer with the alliance tool; bots accept 75% of the time if you're at least half their size. 3 minutes; attacks, missiles and landings between allies are blocked. Bots under attack offer alliances to other neighbours (offers to humans lapse after 20 s), hold one ally at most, and may betray a much weaker ally next door. | `proposeAlliance()`, `diplomacy()` |
| Hydrogen bomb | Third missile: radius 30, 35K gold, needs 3 silos. | `canLaunch()` |
| Warships | Bought at a port by clicking water (6K, one per port, four at most); sail there by water search and patrol. Every 10 ticks they hit the nearest enemy ship or sink a boat within 7 tiles; every 25 ticks they shell the nearest enemy land tile no bunker covers (it turns neutral and stays cratered). | `orderWarship()`, `updateWarships()` |
| Battle royale | After 60 s the sea takes 92% of the land over 8 minutes, outside in along a noise-roughened front; land due within 20 s is marked. The game floods its own copy of the map. | `planFlood()`, `updateFlood()` |
| Teams | 2 or 4 teams, dealt round-robin, each in shades of one hue; teammates are allied for good, spawn near each other and can donate troops and gold. A team wins with 70% between them. | `teammates()`, `donate()`, `checkTeamEnd()` |
| Real maps | World, Europe, Germany: Natural Earth coastlines as run-length masks, mountains along traced real ranges. Every continent is starting land; 50% wins. | `realmaps.ts`, `scripts/build-maps.ts` |
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

Map sizes: 552×345, 920×575, 1380×862 and 1840×1150 tiles, with 3–100 bots. Worst case measured (huge map, 100 normal bots, 4,000 ticks): 4–5 ms a tick on average, 99% of ticks under 16 ms, and no tick over 50 ms after the first. What it took:

- **Encirclement** is checked every second only around tiles that changed hands (regions over 600 tiles wait for the full pass), and the full pass is spread thinly over every tick. Floods are breadth-first and give up as soon as a region can't be annexed.
- **New capitals** are found by searching rings outward from the territory's centre, not by scanning the map.
- **Boats**: every body of water is labelled once, so a route to a different sea is refused at once; bots only sail to islands near their ports.
- **Bunker cover** uses a grid of cells as wide as a bunker's reach; **building spacing** looks only at nearby tiles; **alliances** use numeric keys.

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
| 2. Multiplayer | Lobby server, lockstep tick relay, desync checks via `hash()`, reconnection | Next (needs hosting) |
| 3. Frontwars layer | Gold, cities, defence posts, silos, rockets, nukes, hydrogen bombs, factories with trains, ports with boats, warships, alliances and bot diplomacy, real-world maps | **Done** |
| 4. Polish | Minimap, settings (UI size, panels, volume), game speed, sound, replays from `game.log`, results chart, fog of war, battle royale, teams, daily challenge **done**. Still to come: tutorial match | Mostly done |

## Idea backlog

Done: capital tile, quick match, colour picker, daily challenge (local best time), replays, teams, fog of war, battle royale.

Still open, roughly in order of cost:

- **Emotes**: a few fixed icons instead of chat, nothing to moderate.
- **Replay sharing**: a link that replays a whole match from its intent log.
- **Tutorial bot match**: two guided minutes on expanding, attacking and holding troops back.
- **Map events**: gold rush (cheaper land), storms (no boats).
- **Rebellions**: huge empires occasionally lose a border region to neutral.
- **Daily leaderboard**: needs a server, like multiplayer.
