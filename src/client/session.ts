import { CONFIG } from '../core/config';
import { NEUTRAL, type Game, type GameEvent, type Player } from '../core/game';
import { Terrain } from '../core/map';
import { Camera, type Inset } from './camera';
import { formatClock, formatShare } from './format';
import type { Hud } from './hud';
import { Input, type InputTarget } from './input';
import { Renderer, type Overlay } from './renderer';

const TICK_MS = 1000 / CONFIG.ticksPerSecond;
const NO_INSET: Inset = { left: 0, top: 0, right: 0, bottom: 0 };
const FLIGHT_MS = 500;

interface Flight {
  /** World point at the centre of the screen, and the scale, at each end. */
  from: { x: number; y: number; scale: number };
  to: { x: number; y: number; scale: number };
  start: number;
}

export interface SessionHooks {
  playAgain(): void;
  menu(): void;
}

export interface SessionOptions {
  /** Absent for the menu backdrop, which only shows the map. */
  play?: { hud: Hud; hooks: SessionHooks };
  /** Screen space (CSS pixels) to keep clear when fitting the map, e.g. behind the menu. */
  inset?: () => Inset;
}

/** One match on screen: runs the simulation clock, draws frames and handles input. */
export class Session implements InputTarget {
  private readonly renderer: Renderer;
  private readonly camera = new Camera();
  private readonly input: Input | null = null;
  private readonly me: Player | null;
  private readonly resizeObserver: ResizeObserver;
  private raf = 0;
  private last = 0;
  private backlog = 0;
  private paused = false;
  private hoverTile = -1;
  private sinceLabels = Infinity;
  private sinceHud = Infinity;
  private defeatShown = false;
  private ended = false;
  private spawned = false;
  private flight: Flight | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly game: Game,
    private readonly options: SessionOptions,
  ) {
    this.renderer = new Renderer(canvas, game);
    this.me = game.players.find((p) => !p.bot) ?? null;
    if (options.play && this.me) {
      this.input = new Input(canvas, this.camera, this);
      options.play.hud.show(this.me);
      options.play.hud.setBanner('Pick any spot on land to start.');
      options.play.hud.pauseButton.addEventListener('click', this.onPauseButton);
      options.play.hud.centerButton.addEventListener('click', this.onCenterButton);
      window.addEventListener('keydown', this.onKey);
    }
    // Handy in the dev console and for browser tests; stripped from production builds.
    if (import.meta.env.DEV) (window as unknown as { session: Session }).session = this;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.input?.dispose();
    window.removeEventListener('keydown', this.onKey);
    this.options.play?.hud.pauseButton.removeEventListener('click', this.onPauseButton);
    this.options.play?.hud.centerButton.removeEventListener('click', this.onCenterButton);
  }

  /** Re-fits the map, e.g. after the menu changes size. */
  refit(): void {
    this.fit();
  }

  // Frame loop

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    // Cap the step so a backgrounded tab doesn't fast-forward the match on return.
    const dt = Math.min(250, now - this.last);
    this.last = now;

    if (this.options.play && !this.paused && this.game.phase !== 'over') {
      this.backlog += dt;
      let steps = 0;
      while (this.backlog >= TICK_MS && steps < 4) {
        this.game.step();
        this.backlog -= TICK_MS;
        steps++;
      }
      if (steps === 4) this.backlog = 0;
    }

    this.renderer.applyChanges(this.game.drainChanges());
    if (this.options.play) this.handleEvents(this.game.drainEvents());
    if (!this.spawned && this.me?.spawned) {
      this.spawned = true;
      // On tall phone screens the whole map is small: close in on the new territory.
      if (this.canvas.height > this.canvas.width * 1.1) this.flyToCapital(2.2);
    }
    this.updateFlight(now);

    this.sinceLabels += dt;
    if (this.sinceLabels > 300) {
      this.renderer.labels.recompute();
      this.sinceLabels = 0;
    }
    this.renderer.labels.animate(dt / 1000);
    this.renderer.render(this.camera, this.overlayState());

    this.sinceHud += dt;
    if (this.options.play && this.me && this.sinceHud > 150) {
      this.sinceHud = 0;
      this.options.play.hud.update(this.game, this.me);
    }
  };

  private overlayState(): Overlay {
    const spawning = this.game.phase === 'spawn' && this.me !== null && this.options.play !== undefined;
    return {
      hover: this.hoverTile,
      spawnColor: spawning ? this.me!.color : null,
      spawnValid: spawning && this.canSpawnAt(this.hoverTile),
    };
  }

  private canSpawnAt(tile: number): boolean {
    return this.game.isLand(tile) && this.game.map.terrain[tile] !== Terrain.Mountains;
  }

  // Input

  tap(sx: number, sy: number): void {
    const { game, me } = this;
    const hud = this.options.play?.hud;
    if (!me || !hud || this.paused || hud.overlayOpen) return;
    const tile = this.camera.tileAt(sx, sy, game.width, game.height);
    if (tile < 0) return;

    if (game.phase === 'spawn') {
      if (!game.isLand(tile)) hud.toast('Pick a spot on land.');
      else if (!this.canSpawnAt(tile)) hud.toast('Mountains are too slow to grow from. Pick lower ground.');
      else {
        game.queue({ type: 'spawn', player: me.id, tile });
        hud.setBanner('');
      }
      return;
    }
    if (game.phase !== 'play' || !me.alive) return;
    if (!game.isLand(tile)) {
      hud.toast("Your troops can't cross water yet.");
      return;
    }
    const target = game.owner[tile];
    if (target === me.id) return;
    if (!game.sharesBorder(me, target)) {
      hud.toast(target === NEUTRAL ? 'That land is not next to yours.' : `You don't share a border with ${game.player(target).name}.`);
      return;
    }
    if (me.troops < 2) {
      hud.toast('You have no troops to send yet.');
      return;
    }
    game.queue({ type: 'attack', player: me.id, target, permille: hud.percent * 10 });
  }

  hover(sx: number, sy: number): void {
    this.hoverTile = this.camera.tileAt(sx, sy, this.game.width, this.game.height);
  }

  leave(): void {
    this.hoverTile = -1;
  }

  moved(): void {
    this.flight = null;
    this.camera.clamp(this.canvas.width, this.canvas.height, this.game.width, this.game.height);
  }

  private onKey = (e: KeyboardEvent): void => {
    const hud = this.options.play?.hud;
    if (!hud || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (e.key === ' ' || e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      if (e.key === ' ' && e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      this.togglePause();
      return;
    }
    if (hud.overlayOpen) return;
    if (/^[0-9]$/.test(e.key)) {
      hud.percent = e.key === '0' ? 100 : Number(e.key) * 10;
      e.preventDefault();
    } else if (e.key === 'c' || e.key === 'C') {
      this.flyToCapital(2.5);
    } else if (e.key === '+' || e.key === '=') {
      this.camera.zoomAt(w / 2, h / 2, 1.25);
      this.moved();
    } else if (e.key === '-' || e.key === '_') {
      this.camera.zoomAt(w / 2, h / 2, 0.8);
      this.moved();
    } else {
      const step = Math.min(w, h) * 0.12;
      const pan: Record<string, [number, number]> = {
        ArrowLeft: [step, 0], a: [step, 0],
        ArrowRight: [-step, 0], d: [-step, 0],
        ArrowUp: [0, step], w: [0, step],
        ArrowDown: [0, -step], s: [0, -step],
      };
      const move = pan[e.key];
      if (!move || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      this.camera.panBy(move[0], move[1]);
      this.moved();
    }
  };

  private onPauseButton = (): void => {
    this.togglePause();
  };

  private onCenterButton = (): void => {
    this.flyToCapital(2.5);
  };

  /** Glides the camera to your capital, zooming in to at least `zoom` × the whole-map view. */
  private flyToCapital(zoom: number): void {
    const me = this.me;
    if (!me || me.capital < 0) return;
    const cam = this.camera;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const tx = me.capital % this.game.width;
    const to = { x: tx + 0.5, y: (me.capital - tx) / this.game.width + 0.5, scale: Math.max(cam.scale, cam.fitScale * zoom) };
    const from = { x: (w / 2 - cam.x) / cam.scale, y: (h / 2 - cam.y) / cam.scale, scale: cam.scale };
    cam.moved = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.flight = { from: to, to, start: 0 };
      this.updateFlight(Infinity);
    } else {
      this.flight = { from, to, start: performance.now() };
    }
  }

  private updateFlight(now: number): void {
    const f = this.flight;
    if (!f) return;
    const t = Math.min(1, Math.max(0, (now - f.start) / FLIGHT_MS));
    const e = 1 - (1 - t) ** 3;
    const scale = f.from.scale * (f.to.scale / f.from.scale) ** e;
    const x = f.from.x + (f.to.x - f.from.x) * e;
    const y = f.from.y + (f.to.y - f.from.y) * e;
    this.camera.scale = scale;
    this.camera.centerOn(x - 0.5, y - 0.5, this.canvas.width, this.canvas.height);
    if (t >= 1) {
      this.flight = null;
      this.camera.clamp(this.canvas.width, this.canvas.height, this.game.width, this.game.height);
    }
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.camera.moved) this.moved();
    else this.fit();
  }

  private fit(): void {
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const inset = this.options.inset?.() ?? NO_INSET;
    this.camera.fit(this.canvas.width, this.canvas.height, this.game.width, this.game.height, {
      left: inset.left * dpr,
      top: inset.top * dpr,
      right: inset.right * dpr,
      bottom: inset.bottom * dpr,
    });
  }

  // Pausing and match results

  private togglePause(): void {
    const play = this.options.play;
    if (!play || this.ended || (this.defeatShown && play.hud.overlayOpen)) return;
    this.paused = !this.paused;
    if (!this.paused) {
      play.hud.hideOverlay();
      return;
    }
    play.hud.showOverlay({
      eyebrow: 'Paused',
      title: 'Game paused',
      text: 'Nothing moves until you come back.',
      stats: [],
      actions: [
        { label: 'Resume', primary: true, run: () => this.togglePause() },
        { label: 'New map', run: () => play.hooks.playAgain() },
        { label: 'Quit to menu', run: () => play.hooks.menu() },
      ],
    });
  }

  private handleEvents(events: GameEvent[]): void {
    const hud = this.options.play!.hud;
    const me = this.me!;
    const name = (id: number) => (id === me.id ? 'you' : this.game.player(id).name);
    for (const e of events) {
      if (e.type === 'capitalLost') {
        if (e.player === me.id) hud.post(`${capitalize(name(e.by))} took your capital. You lost half your troops.`, 'bad');
        else if (e.by === me.id) hud.post(`You took ${name(e.player)}'s capital. They lost half their troops.`, 'good');
      } else if (e.type === 'eliminated') {
        if (e.player === me.id) this.showDefeat(e.by);
        else if (e.by === me.id) hud.post(`You wiped out ${name(e.player)}.`, 'good');
        else hud.post(`${name(e.by)} wiped out ${name(e.player)}.`, 'info');
      } else if (e.type === 'encircled') {
        if (e.player === me.id) hud.post(`${capitalize(name(e.by))} cut off ${e.tiles} of your tiles and took them.`, 'bad');
        else if (e.by === me.id) hud.post(`You cut off ${e.tiles} tiles from ${name(e.player)} and took them.`, 'good');
      } else if (e.type === 'gameOver') {
        this.showResult(e.winner);
      }
    }
  }

  private matchTime(): string {
    return formatClock(this.game.tick / CONFIG.ticksPerSecond);
  }

  private stats(): [string, string][] {
    const me = this.me!;
    const place = me.place || this.game.players.filter((p) => p.alive && p.tiles > me.tiles).length + 1;
    return [
      ['Place', `${place} of ${this.game.players.length}`],
      ['Most land', formatShare(me.peakTiles / this.game.map.landTiles)],
      ['Time', this.matchTime()],
    ];
  }

  private showDefeat(by: number): void {
    const play = this.options.play!;
    this.defeatShown = true;
    play.hud.showOverlay({
      eyebrow: 'Defeat',
      title: 'Eliminated',
      text: `${this.game.player(by).name} took your last tile after ${this.matchTime()}.`,
      stats: this.stats(),
      actions: [
        { label: 'Play again', primary: true, run: () => play.hooks.playAgain() },
        { label: 'Keep watching', run: () => play.hud.hideOverlay() },
        { label: 'Menu', run: () => play.hooks.menu() },
      ],
    });
    play.hud.setBanner('You are watching. The bots play on.');
  }

  private showResult(winnerId: number): void {
    const play = this.options.play!;
    const me = this.me!;
    const winner = this.game.player(winnerId);
    const share = formatShare(winner.tiles / this.game.map.landTiles);
    const timed = this.game.settings.timeLimit > 0 && this.game.tick >= this.game.settings.timeLimit;
    const lastStanding = this.game.players.filter((p) => p.alive).length === 1;
    this.ended = true;
    play.hud.setBanner('');

    let eyebrow: string;
    let title: string;
    let text: string;
    if (winnerId === me.id) {
      eyebrow = 'Victory';
      title = lastStanding ? 'Last one standing' : timed ? 'Most land at the bell' : 'The map is yours';
      text = timed ? `Time's up. You hold ${share} of the land.` : `You hold ${share} of the land after ${this.matchTime()}.`;
    } else {
      eyebrow = me.alive ? 'Defeat' : 'Match over';
      title = `${winner.name} wins`;
      text = timed
        ? `Time's up. ${winner.name} holds ${share} of the land.`
        : `${winner.name} took ${share} of the land after ${this.matchTime()}.`;
    }
    play.hud.showOverlay({
      eyebrow,
      title,
      text,
      stats: this.stats(),
      actions: [
        { label: 'Play again', primary: true, run: () => play.hooks.playAgain() },
        { label: 'Menu', run: () => play.hooks.menu() },
      ],
    });
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
