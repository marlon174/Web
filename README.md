# Landgrab

A territory-conquest strategy game for the browser, in the spirit of territorial.io and frontwars.io. You start on a few tiles of a generated continent, grow troops and push your borders against bots until the map is yours.

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
