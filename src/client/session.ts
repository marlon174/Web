import { CONFIG } from '../core/config';
import { NEUTRAL, type Game, type GameEvent, type Player } from '../core/game';
import { Terrain } from '../core/map';
import { Camera, type Inset } from './camera';
import { formatClock, formatShare, formatTroops } from './format';
import type { Hud } from './hud';
import { Input, type InputTarget } from './input';
import { Renderer, type Overlay } from './renderer';
import { isMissile, TOOLS, type ToolKind } from './tools';

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
  private spawnedAt = 0;
  private flight: Flight | null = null;
  /** Build or missile tool in hand, waiting for a click on the map. */
  private tool: ToolKind | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly game: Game,
    private readonly options: SessionOptions,
  ) {
    this.me = game.players.find((p) => !p.bot) ?? null;
    this.renderer = new Renderer(canvas, game, this.me?.id ?? null);
    if (options.play && this.me) {
      this.input = new Input(canvas, this.camera, this);
      options.play.hud.onTool = (kind) => this.selectTool(kind);
      options.play.hud.show(this.me);
      options.play.hud.setBanner('Klick auf eine beliebige Stelle an Land, um dort zu starten.');
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
      this.spawnedAt = now;
      // Close in on the new territory, more on tall phone screens where the whole map is small.
      this.flyToCapital(this.canvas.height > this.canvas.width * 1.1 ? 2.2 : 1.5);
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
      this.options.play.hud.updateTools(this.game, this.me, this.tool);
    }
  };

  private overlayState(): Overlay {
    const spawning = this.game.phase === 'spawn' && this.me !== null && this.options.play !== undefined;
    return {
      hover: this.hoverTile,
      spawnColor: spawning ? this.me!.color : null,
      spawnValid: spawning && this.canSpawnAt(this.hoverTile),
      tool: this.tool && this.me ? { kind: this.tool, valid: this.toolRefusal(this.tool, this.hoverTile) === null } : null,
      tick: this.game.tick + (this.paused ? 0 : this.backlog / TICK_MS),
      spawnedAt: this.spawnedAt,
    };
  }

  // Building and missiles

  /** Why the tool can't be used on this tile, or null if it can. Tile -1: only the checks that don't depend on a spot. */
  private toolRefusal(kind: ToolKind, tile: number): string | null {
    const { game, me } = this;
    if (!me || game.phase !== 'play' || !me.alive) return 'Warte, bis die Partie läuft.';
    if (kind === 'ally') {
      if (tile < 0) return null;
      const o = game.owner[tile];
      if (o === NEUTRAL || o === me.id) return 'Klick auf das Land eines anderen Spielers.';
      return null;
    }
    if (isMissile(kind)) {
      const refusal = game.canLaunch(me, kind);
      if (refusal === 'noSilo') return 'Bau zuerst ein Raketensilo.';
      if (refusal === 'gold') return `${kind === 'nuke' ? 'Eine Atombombe' : 'Eine Rakete'} kostet ${formatTroops(game.missileCost(kind))} Gold.`;
      if (tile >= 0 && game.allied(me.id, game.owner[tile])) return 'Du kannst nicht auf Verbündete schießen.';
      return null;
    }
    if (tile < 0) return me.gold < game.buildCost(me, kind) ? `Das kostet ${formatTroops(game.buildCost(me, kind))} Gold.` : null;
    switch (game.canBuild(me, kind, tile)) {
      case 'gold':
        return `Das kostet ${formatTroops(game.buildCost(me, kind))} Gold.`;
      case 'notYours':
      case 'offMap':
        return 'Bau auf deinem eigenen Land.';
      case 'notCoast':
        return 'Häfen müssen direkt am Wasser stehen.';
      case 'tooClose':
        return 'Zu nah an einem anderen Gebäude. Lass 4 Felder Abstand.';
      default:
        return null;
    }
  }

  private selectTool(kind: ToolKind): void {
    const hud = this.options.play?.hud;
    if (!hud || !this.me || this.paused || hud.overlayOpen) return;
    if (this.tool === kind) {
      this.cancel();
      return;
    }
    // Refuse up front when nothing on the map could work (no gold, no silo).
    const refusal = this.toolRefusal(kind, -1);
    if (refusal) {
      hud.toast(refusal);
      return;
    }
    this.tool = kind;
    const name = TOOLS.find((t) => t.kind === kind)!.name;
    const building: Record<string, string> = {
      city: 'eine Stadt',
      factory: 'eine Fabrik',
      port: 'einen Hafen (an der Küste)',
      defense: 'einen Bunker',
      silo: 'ein Raketensilo',
    };
    const cancel = 'Rechtsklick oder Esc bricht ab.';
    hud.setBanner(
      kind === 'ally'
        ? `Klick auf das Land eines Spielers für ein Bündnis (oder um eins zu beenden). ${cancel}`
        : isMissile(kind)
          ? `Klick auf ein Ziel für deine ${name}. ${cancel}`
          : `Klick auf dein Land, um ${building[kind]} zu bauen. ${cancel}`,
    );
    hud.updateTools(this.game, this.me, this.tool);
  }

  cancel(): void {
    if (!this.tool) return;
    this.tool = null;
    const hud = this.options.play?.hud;
    if (hud && this.me) {
      hud.setBanner('');
      hud.updateTools(this.game, this.me, null);
    }
  }

  private useTool(kind: ToolKind, tile: number): void {
    const hud = this.options.play!.hud;
    const me = this.me!;
    const refusal = this.toolRefusal(kind, tile);
    if (refusal) {
      hud.toast(refusal);
      return;
    }
    if (kind === 'ally') {
      const target = this.game.owner[tile];
      if (this.game.allied(me.id, target)) this.game.queue({ type: 'breakAlly', player: me.id, target });
      else this.game.queue({ type: 'ally', player: me.id, target });
    } else if (isMissile(kind)) this.game.queue({ type: 'launch', player: me.id, tile, kind });
    else this.game.queue({ type: 'build', player: me.id, tile, kind });
    this.cancel();
  }

  /** Land across the water: ship the troops over from a port. */
  private sendBoat(tile: number): void {
    const hud = this.options.play!.hud;
    const me = this.me!;
    const plan = this.game.planBoat(me, tile);
    const why: Record<string, string> = {
      noPort: 'Dieses Land grenzt nicht an deins. Mit einem Hafen kannst du übers Wasser übersetzen.',
      boats: `Du hast schon ${CONFIG.maxBoats} Boote unterwegs.`,
      ally: 'Dort wohnt ein Verbündeter.',
      noRoute: 'Kein Seeweg von deinen Häfen zu dieser Küste.',
      offMap: 'Ziel auf Land.',
    };
    if (typeof plan === 'string') {
      hud.toast(why[plan] ?? 'Dorthin kann kein Boot fahren.');
      return;
    }
    if (me.troops < 2) {
      hud.toast('Du hast noch keine Truppen zum Losschicken.');
      return;
    }
    this.game.queue({ type: 'boat', player: me.id, tile, permille: hud.percent * 10 });
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
      if (!game.isLand(tile)) hud.toast('Wähl eine Stelle an Land.');
      else if (!this.canSpawnAt(tile)) hud.toast('Auf Bergen wächst man zu langsam. Wähl tieferes Land.');
      else {
        game.queue({ type: 'spawn', player: me.id, tile });
        hud.setBanner('');
      }
      return;
    }
    if (this.tool) {
      this.useTool(this.tool, tile);
      return;
    }
    if (game.phase !== 'play' || !me.alive) return;
    if (!game.isLand(tile)) {
      hud.toast('Klick auf Land jenseits des Wassers. Boote brauchen einen Hafen.');
      return;
    }
    const target = game.owner[tile];
    if (target === me.id) return;
    if (game.allied(me.id, target)) {
      hud.toast(`${game.player(target).name} ist dein Verbündeter.`);
      return;
    }
    if (!game.sharesBorder(me, target)) {
      if (me.owned.port > 0) this.sendBoat(tile);
      else hud.toast(target === NEUTRAL ? 'Dieses Land grenzt nicht an deins. Mit einem Hafen kommst du übers Wasser.' : `Du hast keine gemeinsame Grenze mit ${game.player(target).name}.`);
      return;
    }
    if (me.troops < 2) {
      hud.toast('Du hast noch keine Truppen zum Losschicken.');
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
    if (e.key === 'Escape' && this.tool) {
      this.cancel();
      return;
    }
    const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
    if (tool && !hud.overlayOpen) {
      this.selectTool(tool.kind);
      return;
    }
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
        ArrowLeft: [step, 0],
        ArrowRight: [-step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
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
      eyebrow: 'Pause',
      title: 'Spiel pausiert',
      text: 'Nichts bewegt sich, bis du weiterspielst.',
      stats: [],
      actions: [
        { label: 'Weiter', primary: true, run: () => this.togglePause() },
        { label: 'Neue Karte', run: () => play.hooks.playAgain() },
        { label: 'Zum Menü', run: () => play.hooks.menu() },
      ],
    });
  }

  private handleEvents(events: GameEvent[]): void {
    const hud = this.options.play!.hud;
    const me = this.me!;
    const name = (id: number) => (id === me.id ? 'du' : this.game.player(id).name);
    for (const e of events) {
      if (e.type === 'capitalLost') {
        if (e.player === me.id) hud.post(`${name(e.by)} hat deine Hauptstadt erobert. Du hast die Hälfte deiner Truppen verloren.`, 'bad');
        else if (e.by === me.id) hud.post(`Du hast die Hauptstadt von ${name(e.player)} erobert. Sie verlieren die Hälfte ihrer Truppen.`, 'good');
      } else if (e.type === 'eliminated') {
        if (e.player === me.id) this.showDefeat(e.by);
        else if (e.by === me.id) hud.post(`Du hast ${name(e.player)} ausgelöscht.`, 'good');
        else hud.post(`${name(e.by)} hat ${name(e.player)} ausgelöscht.`, 'info');
      } else if (e.type === 'encircled') {
        if (e.player === me.id) hud.post(`${name(e.by)} hat ${e.tiles} deiner Felder abgeschnitten und übernommen.`, 'bad');
        else if (e.by === me.id) hud.post(`Du hast ${e.tiles} Felder von ${name(e.player)} abgeschnitten und übernommen.`, 'good');
      } else if (e.type === 'captured') {
        const what = { defense: 'den Bunker', silo: 'das Raketensilo', city: 'die Stadt', port: 'den Hafen', factory: 'die Fabrik' }[e.kind];
        if (e.by === me.id) hud.post(`Du hast ${what} von ${name(e.from)} erobert.`, 'good');
        else if (e.from === me.id) hud.post(`${name(e.by)} hat ${what} von dir erobert.`, 'bad');
      } else if (e.type === 'launched') {
        const m = e.missile;
        const what = m.kind === 'nuke' ? 'eine Atombombe' : 'eine Rakete';
        if (m.victim === me.id && m.owner !== me.id) hud.post(`${name(m.owner)} hat ${what} auf dich abgefeuert!`, 'bad');
        else if (m.kind === 'nuke' && m.owner !== me.id && m.victim !== NEUTRAL) hud.post(`${name(m.owner)} hat eine Atombombe auf ${name(m.victim)} abgefeuert.`, 'info');
      } else if (e.type === 'impact') {
        this.renderer.explode(e.missile);
        const mine = e.losses.find((l) => l.player === me.id);
        const what = e.missile.kind === 'nuke' ? 'Atombombe' : 'Rakete';
        if (mine && e.missile.owner !== me.id) {
          hud.post(`Eine ${what} von ${name(e.missile.owner)} hat ${mine.tiles} deiner Felder zerstört.`, 'bad');
        } else if (e.missile.owner === me.id) {
          const tiles = e.losses.filter((l) => l.player !== me.id).reduce((sum, l) => sum + l.tiles, 0);
          const extra = e.buildings ? ` und ${e.buildings} Gebäude` : '';
          hud.post(`Deine ${what} hat ${tiles} feindliche Felder${extra} zerstört.`, 'good');
        }
      } else if (e.type === 'bunkerDestroyed') {
        if (e.by === me.id) hud.post(`Du hast einen Bunker von ${name(e.from)} zerstört.`, 'good');
        else if (e.from === me.id) hud.post(`${name(e.by)} hat einen deiner Bunker zerstört.`, 'bad');
      } else if (e.type === 'trainStop') {
        if (e.owner === me.id) this.renderer.floatText(e.tile, `+${formatTroops(e.gold)}`);
      } else if (e.type === 'landed') {
        if (e.owner === me.id) hud.post(e.target === NEUTRAL ? 'Deine Truppen sind gelandet.' : `Deine Truppen sind bei ${name(e.target)} gelandet.`, 'good');
        else if (e.target === me.id) hud.post(`${name(e.owner)} ist an deiner Küste gelandet!`, 'bad');
      } else if (e.type === 'repelled') {
        if (e.owner === me.id) hud.post('Deine Landung wurde abgewehrt.', 'bad');
        else if (e.target === me.id) hud.post(`Du hast eine Landung von ${name(e.owner)} abgewehrt.`, 'good');
      } else if (e.type === 'alliance') {
        if (e.from === me.id) hud.post(e.accepted ? `${name(e.to)} ist jetzt dein Verbündeter (3 Minuten).` : `${name(e.to)} lehnt ein Bündnis ab. Versuch es später nochmal.`, e.accepted ? 'good' : 'info');
        else if (e.to === me.id && e.accepted) hud.post(`${name(e.from)} ist jetzt dein Verbündeter.`, 'good');
      } else if (e.type === 'allianceEnded') {
        const other = e.a === me.id ? e.b : e.b === me.id ? e.a : NEUTRAL;
        if (other !== NEUTRAL) {
          if (e.brokenBy === me.id) hud.post(`Du hast das Bündnis mit ${name(other)} beendet.`, 'info');
          else if (e.brokenBy === other) hud.post(`${name(other)} hat das Bündnis gebrochen!`, 'bad');
          else hud.post(`Das Bündnis mit ${name(other)} ist abgelaufen.`, 'info');
        }
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
      ['Platz', `${place} von ${this.game.players.length}`],
      ['Meistes Land', formatShare(me.peakTiles / this.game.map.landTiles)],
      ['Zeit', this.matchTime()],
    ];
  }

  private showDefeat(by: number): void {
    const play = this.options.play!;
    this.defeatShown = true;
    play.hud.showOverlay({
      eyebrow: 'Niederlage',
      title: 'Ausgeschieden',
      text: `${this.game.player(by).name} hat nach ${this.matchTime()} dein letztes Feld erobert.`,
      stats: this.stats(),
      actions: [
        { label: 'Nochmal spielen', primary: true, run: () => play.hooks.playAgain() },
        { label: 'Weiter zuschauen', run: () => play.hud.hideOverlay() },
        { label: 'Menü', run: () => play.hooks.menu() },
      ],
    });
    play.hud.setBanner('Du schaust zu. Die Bots spielen weiter.');
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
      eyebrow = 'Sieg';
      title = lastStanding ? 'Als Letzter übrig' : timed ? 'Das meiste Land zum Schluss' : 'Die Karte gehört dir';
      text = timed ? `Die Zeit ist um. Dir gehören ${share} des Landes.` : `Nach ${this.matchTime()} gehören dir ${share} des Landes.`;
    } else {
      eyebrow = me.alive ? 'Niederlage' : 'Partie vorbei';
      title = `${winner.name} gewinnt`;
      text = timed
        ? `Die Zeit ist um. ${winner.name} gehören ${share} des Landes.`
        : `${winner.name} hat nach ${this.matchTime()} ${share} des Landes erobert.`;
    }
    play.hud.showOverlay({
      eyebrow,
      title,
      text,
      stats: this.stats(),
      actions: [
        { label: 'Nochmal spielen', primary: true, run: () => play.hooks.playAgain() },
        { label: 'Menü', run: () => play.hooks.menu() },
      ],
    });
  }
}
