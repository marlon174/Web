# Landgrab

A territory-conquest strategy game for the browser (German interface), in the spirit of territorial.io and frontwars.io. You start on a few tiles of a generated continent (up to 1600×1000 tiles, with up to 100 bots), grow troops and push your borders until the map is yours.

## Run it

```sh
npm install
npm run dev        # play at http://localhost:5173
npm test           # simulation tests
npm run build      # typecheck and build a static site into dist/
npm run sim        # play a bots-only match in the terminal: npm run sim -- [seed] [bots] [easy|normal|hard] [small|medium|large]
```

## How to play

- **Pick a start.** Click any spot on land (not mountains).
- **Expand.** Click empty land to push into it along your whole border.
- **Attack.** Click a neighbour's land. Attacking costs more than it costs them to defend, so pick on thin defences.
- **Send.** The slider (or keys `1`–`0`) sets what share of your troops each click commits.
- **Grow.** Troops grow fastest when you are well below your cap, and the cap rises with your land. Sitting at the cap wastes growth.
- **Capitals.** The star in a ring is a capital. Losing yours costs half your troops, and a new one is picked inside your land.
- **Encircle.** Enemy land cut off from its capital by you alone becomes yours, and so do small pockets of empty land inside your territory.
- **Gold and buildings.** Land earns gold. Press `Q` for a city (+20% troop cap), `R` for a bunker (land within 12 tiles costs attackers 3.5×, falls much slower, and you lose half as many troops there; an enemy who overruns it destroys it), `T` for a missile silo, then click your land.
- **Height.** The higher the ground, the slower and dearer it is to take. Low meadows are quick; mountain peaks are fortresses.
- **Prices and limits.** Each building of a kind you already own adds a fixed amount to the next one's price, up to a cap. How many you can build grows with your land (for cities: 2 plus 1 per 2,500 tiles). Cities add +20% troop cap each, up to +100%. Silos reload for 10 seconds after each launch.
- **Factories and trains (`W`).** A factory lays rail to your cities and ports within 60 tiles. Every minute a train runs the line; each city or port it passes pays 10K gold.
- **Ports and boats (`E`).** Build a port on the coast, then click land across the water: troops sail over and land. Islands can only be reached this way.
- **Alliances (`H`).** Click another player's land to offer a 3-minute alliance; allies can't attack or bomb each other. Use it on an ally to end it early.
- **Missiles.** With a silo, press `F` (rocket) or `G` (nuke) and click any target. The blast turns land neutral, destroys buildings and kills troops; bombed ground stays poisoned for 30 seconds. Right-click or `Esc` cancels.
- **Win.** Quick match: most land after 5 minutes. Classic: hold 80% of the land.

Controls: drag to pan, scroll or pinch to zoom, `C` or the target button to find your capital, `Space` to pause.

## Project layout

```
src/core/     the simulation: no DOM, deterministic, runs the same anywhere
  game.ts       players, troops, attacks, capitals, encirclement, win rules
  bots.ts       bot decisions
  map.ts        map generation (seeded noise) and terrain
  config.ts     every balance number
  setup.ts      builds a match: map, players, names, colours
src/client/   the browser game: rendering, input, HUD, menu
tests/        simulation tests (vitest)
scripts/      headless tools, e.g. the balance simulator
```

See [DESIGN.md](DESIGN.md) for how it works and what comes next.
