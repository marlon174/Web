/**
 * Every gameplay number in one place, so balance changes stay small diffs.
 * Rates are per tick; the game runs at `ticksPerSecond`.
 */
export const CONFIG = {
  ticksPerSecond: 10,

  // Economy
  startTroops: 1000,
  spawnRadius: 3,
  /** Troop cap = tiles × this. */
  troopsPerTile: 100,
  /** Share of your troops added each tick, fading to nothing as you near the cap. */
  interest: 0.004,
  /** Flat troops per owned tile per tick. */
  landIncome: 0.02,
  /** Share of troops above the cap that desert each tick. */
  overflowDecay: 0.003,

  // Combat
  /** Troops to take one plains tile of neutral land. */
  neutralCost: 2,
  /**
   * Attacking a player costs this × the defender's troops per tile, on top of
   * the neutral cost. The defender loses one tile's worth of troops.
   */
  defenseFactor: 2,
  /** Share of troops a player loses along with their capital. */
  capitalPenalty: 0.5,
  /**
   * Cost multiplier per terrain: water, plains, hills, mountains. Each tile is
   * judged on its own, so only the part of a front that is climbing slows down.
   */
  terrainCost: [0, 1, 1.6, 2.8],
  /** Base ticks for a front to cross one tile of each terrain. */
  terrainDelay: [0, 2, 4, 9],
  /** Extra ticks per tile when the tile belongs to another player. */
  enemyDelay: 2,
  /** Speed multiplier for all fronts (1.1 = 10% faster than the delays above). */
  troopSpeed: 1.21,
  /**
   * Against a player, a front's speed scales with √(attacking troops ÷ defender's troops),
   * kept between these bounds: twice their troops ≈ 1.4× faster, three times ≈ 1.7×.
   */
  pressureMin: 0.8,
  pressureMax: 2.5,
  /** Random extra ticks per tile, so fronts grow unevenly. */
  delayJitter: 2,

  // Territory
  /** Ticks between checks for encircled land. */
  sweepEvery: 10,
  /** Neutral pockets up to this many tiles are absorbed by the player around them... */
  pocketMax: 400,
  /** ...as long as the pocket is under this share of that player's land. */
  pocketShare: 0.1,

  // Match
  /** Share of all land that wins a match outright. */
  winShare: 0.7,

  // Gold and buildings
  /** Gold per owned tile per tick. */
  goldPerTile: 0.006,
  /**
   * Gold price of the first building of each kind; each one you already own
   * adds `step`, up to `max`. (20 cities: the 21st costs 20K, not trillions.)
   */
  buildings: {
    city: { cost: 2000, step: 1000, max: 20000 },
    defense: { cost: 1500, step: 500, max: 8000 },
    silo: { cost: 5000, step: 2500, max: 20000 },
    port: { cost: 3000, step: 1500, max: 12000 },
    factory: { cost: 6000, step: 3000, max: 24000 },
  },
  /** Buildings stand at least this many tiles apart (in both directions). */
  buildingSpacing: 4,
  /** Each city raises your troop cap by this share, up to `cityCapMax` in total. */
  cityCapBonus: 0.2,
  cityCapMax: 1,
  /**
   * How many of each building a player may build: 2, plus one per this many
   * tiles of land. Stops a big empire from carpeting the map.
   */
  tilesPerBuilding: { city: 2500, defense: 1500, silo: 6000, port: 4000, factory: 8000 },
  /** Land within this radius of a defence post costs attackers `defenseCostFactor` × more and falls slower. */
  defenseRadius: 12,
  defenseCostFactor: 3.5,
  defenseDelay: 6,
  /** Inside a bunker's range the defender loses only this share of the usual troops per tile. */
  defenseLossFactor: 0.5,

  // Missiles
  missiles: {
    rocket: { cost: 3000, radius: 5 },
    nuke: { cost: 10000, radius: 16 },
    hbomb: { cost: 35000, radius: 30 },
  },
  /** Silos you must own before you can fire a hydrogen bomb. */
  hbombSilos: 3,
  /** Ticks a silo needs to reload after each launch. */
  siloReload: 100,
  /** Tiles a missile covers per tick, and its shortest flight. */
  missileSpeed: 3,
  missileMinFlight: 20,
  /** Troops lost per destroyed tile, as a multiple of the owner's troops per tile. */
  missileTroopLoss: 2,
  /** Ticks that bombed land stays contaminated: it isn't absorbed as a pocket and costs more to take. */
  falloutTicks: 300,
  falloutCostFactor: 2,

  /** Fog of war: how far (tiles) a player sees past their own land, boats and ships. */
  fogSight: 24,

  // Battle royale
  royale: {
    /** Ticks before the sea starts to rise. */
    grace: 600,
    /** Ticks over which it swallows `share` of the land, outside in. */
    duration: 4800,
    share: 0.92,
    /** Land about to flood is marked this many ticks ahead. */
    warning: 200,
  },

  // Warships
  warship: {
    cost: 6000,
    /** Hits a ship takes before it sinks. */
    hp: 5,
    /** Reach of its guns, in tiles. */
    range: 7,
    /** Ticks per tile it sails. */
    pace: 2,
    /** Ticks between shots at ships and boats, and between shells at the coast. */
    fireEvery: 10,
    shellEvery: 25,
    /** How far from its station it roams while on patrol. */
    patrol: 12,
    /** Ships per port you own, and at most this many in all. */
    perPort: 1,
    max: 4,
  },

  // Trains
  /** A factory links by rail to your cities and ports within this many tiles... */
  railRange: 60,
  /** ...up to this many of them, nearest first. */
  railStops: 6,
  /** Ticks between a factory's trains (600 = one a minute). */
  trainInterval: 600,
  /** Tiles a train covers per tick. */
  trainSpeed: 1.2,
  /** Gold for each of your cities or ports a train passes through. */
  trainStopGold: 10000,

  // Boats
  /** Tiles a boat sails per tick. */
  boatSpeed: 2,
  /** Boats a player can have at sea at once. */
  maxBoats: 3,
  /** How far inland from the clicked spot to look for a beach. */
  landingSearch: 12,

  // Alliances
  /** Ticks an alliance lasts (1800 = 3 minutes). */
  allianceTicks: 1800,
  /** After an alliance ends or is refused, ticks before the same bot will talk again. */
  allianceCooldown: 600,
  /** Ticks an alliance offer to a human stays open. */
  allianceOfferTicks: 200,
} as const;
