# Landgrab

A territory-conquest strategy game for the browser (German interface), in the spirit of territorial.io and frontwars.io. You start on a few tiles of a generated continent (up to 1840×1150 tiles, with up to 100 bots), grow troops and push your borders until the map is yours.

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
- **Attack.** Click a neighbour's land. Attacking costs more than it costs them to defend, so pick on thin defences. The more you outnumber them, the faster your front moves (√ of the troop ratio, 0.8× to 2.5×; shown as ⚡ on the attack).
- **Send.** The slider (or keys `1`–`0`) sets what share of your troops each click commits. Click one of your attacks under the map to call it off; the survivors come home.
- **Scout.** Hover over (or tap) land to see who holds it, their troops and what a tile would cost you. The minimap (bottom right) jumps anywhere on click.
- **Grow.** Troops grow fastest when you are well below your cap, and the cap rises with your land. Sitting at the cap wastes growth.
- **Capitals.** The star in a ring is a capital. Losing yours costs half your troops, and a new one is picked inside your land.
- **Encircle.** Enemy land cut off from its capital by you alone becomes yours (unless it touches the sea), and so do small pockets of empty land inside your territory.
- **Gold and buildings.** Land earns gold. Press `Q` for a city (+20% troop cap), `R` for a bunker (land within 12 tiles costs attackers 3.5×, falls much slower, and you lose half as many troops there; an enemy who overruns it destroys it), `T` for a missile silo, then click your land.
- **Terrain.** Green plains are quick, brown hills slow, grey mountains (with snow on the peaks) very slow and dear. Each tile counts on its own: only the part of a front that is climbing slows down, and a tile the attack can't afford is skipped rather than ending the attack.
- **Prices and limits.** Each building of a kind you already own adds a fixed amount to the next one's price, up to a cap. How many you can build grows with your land (for cities: 2 plus 1 per 2,500 tiles). Cities add +20% troop cap each, up to +100%. Silos reload for 10 seconds after each launch.
- **Factories and trains (`W`).** A factory lays rail to your cities and ports within 60 tiles. Every minute a train runs the line; each city or port it passes pays 10K gold.
- **Ports and boats (`E`).** Build a port on the coast, then click land across the water: troops sail over and land. Islands can only be reached this way.
- **Alliances (`H`).** Click another player's land to offer a 3-minute alliance; allies can't attack or bomb each other. Use it on an ally to end it early. Bots also offer you alliances (accept within 20 seconds), ally with each other, and sometimes betray an ally who has grown weak.
- **Warships (`V`).** With a port, click open water: a warship sails there from your nearest port (6K gold, one per port, four at most). It sinks enemy boats and ships in range and shells enemy coast that no bunker covers. Once you're at the limit, the same tool steers your nearest ship.
- **Missiles.** With a silo, press `F` (rocket) or `G` (nuke) and click any target. With 3 silos, `B` fires a hydrogen bomb (radius 30, 35K gold). The blast turns land neutral, destroys buildings and kills troops; bombed ground stays poisoned for 30 seconds. Right-click or `Esc` cancels.
- **Real maps** (menu: Welt, Europa, Deutschland). Coastlines from Natural Earth (public domain), rasterised by `scripts/build-maps.ts` into compact run-length masks; mountains and hills follow the real ranges (Himalaya, Alps, Andes, Rockies, the German uplands...). Bots start on every continent. As oceans split the land, 50% wins a classic match there.
- **Daily challenge** (menu card). Everyone gets the same map and bots on the same date, with a twist that changes by weekday (battle royale, fog, teams, hard bots, a big map...). Win as fast as you can; your best time today is kept in this browser.
- **Teams** (menu: 2 or 4 teams). Bots are dealt round the teams, each team in shades of one colour. Teammates are allied for good and start near each other. Click a teammate's land to send them troops (the send slider decides how many); use the alliance tool on them to give a third of your gold. A team wins together with 70% of the land between them.
- **Fog of war** (menu option). You see only your land, your allies', and a band around them and your boats and ships. The rest of the map is fully dark: no terrain, names, missiles or blasts show through, the info card says only "Im Nebel", and the leaderboard shows "?" for players with no land in sight.
- **Win.** Quick match: most land after 5 minutes. Classic: hold 70% of the land. Battle royale: after a minute the sea rises and swallows the map from the outside in over 8 minutes (land tinted red goes under within 20 seconds); hold 70% of what's left, or be the last one standing.

Controls: drag to pan, scroll or pinch to zoom, `C` or the target button to find your capital, `X` or the speed button to run the match at 1×, 2× or 3×, `Space` to pause.

Settings (gear button, in the menu and in a match): UI size from 60% to 140%, sound volume (all sounds are synthesised, no audio files), and switches to hide the leaderboard, event feed, minimap and key hints. They are kept in this browser.

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
