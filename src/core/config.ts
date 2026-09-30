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
  /** Cost multiplier per terrain: water, plains, highlands, mountains. */
  terrainCost: [0, 1, 1.5, 2.5],
  /** Ticks for a front to cross one tile of each terrain. */
  terrainDelay: [0, 2, 3, 5],
  /** Extra ticks per tile when the tile belongs to another player. */
  enemyDelay: 2,
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
  winShare: 0.8,
} as const;
