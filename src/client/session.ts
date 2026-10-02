import { CONFIG } from '../core/config';
import { NEUTRAL, type BuildingKind, type Game, type GameEvent, type Intent, type Player } from '../core/game';
import { Terrain } from '../core/map';
import { Camera, type Inset } from './camera';
import { chartData, LandHistory, landChart } from './chart';
import { Fog } from './fog';
import { formatClock, formatCount, formatShare, formatTroops } from './format';
import { byId, type Hud } from './hud';
import { Input, type InputTarget } from './input';
import { Renderer, type Overlay } from './renderer';
import { uiScale } from './settings';
import { takeTip, TIPS, type TipId } from './tips';
import type { Tutorial } from './tutorial';
import { sound } from './sound';
import { isMissile, TOOLS, type ToolKind } from './tools';

const TICK_MS = 1000 / CONFIG.ticksPerSecond;
/** Game speeds the speed button cycles through, while playing and while watching a replay. */
const SPEEDS = [1, 2, 3];
const REPLAY_SPEEDS = [1, 2, 4, 8];

export type IntentLog = readonly { tick: number; intent: Intent }[];
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
  /** Watch the match just played again from the start. */
  replay(log: IntentLog): void;
  /** Told how a match ended for you (not for replays); may return a line to add to the results. */
  result?(won: boolean, seconds: number): string | null;
}

export interface SessionOptions {
  /** Absent for the menu backdrop, which only shows the map. */
  play?: { hud: Hud; hooks: SessionHooks; replay?: IntentLog; fog?: boolean; tutorial?: Tutorial };
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
  private speed = 1;
  private hoverTile = -1;
  /** Cursor position (CSS pixels) for the info card, or null when off the map. */
  private tipAt: { x: number; y: number } | null = null;
  private tipTimer = 0;
  private sinceLabels = Infinity;
  private sinceHud = Infinity;
  private defeatShown = false;
  private ended = false;
  private spawned = false;
  private spawnedAt = 0;
  private flight: Flight | null = null;
  /** Build or missile tool in hand, waiting for a click on the map. */
  private tool: ToolKind | null = null;
  private readonly history = new LandHistory();
  /** Intents to feed back in, when this session replays a finished match. */
  private readonly replay: IntentLog | null;
  private replayAt = 0;
  private lastShellNote = -Infinity;
  private floodAnnounced = false;
  private lastTip = -Infinity;
  /** The result goes to the hooks once per match: on defeat, or at the end if still in. */
  private resultReported = false;
  private readonly fog: Fog | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly game: Game,
    private readonly options: SessionOptions,
  ) {
    this.me = game.players.find((p) => !p.bot) ?? null;
    this.replay = options.play?.replay ?? null;
    this.renderer = new Renderer(canvas, game, this.me?.id ?? null);
    // The HUD outlives sessions: forget the last match's fog.
    if (options.play) options.play.hud.unseen = () => false;
    if (options.play?.fog && this.me && !options.play.replay) {
      const fog = new Fog(game, this.me.id);
      this.fog = fog;
      this.renderer.fog = fog;
      options.play.hud.unseen = (id) => fog.unseen(id);
    }
    if (options.play && this.me) {
      this.input = new Input(canvas, this.camera, this);
      options.play.hud.onTool = (kind) => this.selectTool(kind);
      options.play.hud.onRecall = (target) => {
        if (!this.me || this.replay) return;
        this.game.queue({ type: 'recall', player: this.me.id, target });
        options.play?.hud.toast('Truppen zurückgerufen.');
      };
      options.play.hud.onOffer = (from, accept) => {
        if (!this.me || this.replay) return;
        if (accept) this.game.queue({ type: 'ally', player: this.me.id, target: from });
        else options.play?.hud.toast(`Du hast ${this.game.player(from).name} abgewiesen.`);
      };
      options.play.hud.minimap.addEventListener('pointerdown', this.onMinimap);
      options.play.hud.minimap.addEventListener('pointermove', this.onMinimap);
      options.play.hud.show(this.me);
      options.play.hud.root.classList.toggle('replay', this.replay !== null);
      // The tutorial card explains the start itself.
      options.play.hud.setBanner(this.replay || options.play.tutorial ? '' : 'Klick auf eine beliebige Stelle an Land, um dort zu starten.');
      options.play.hud.pauseButton.addEventListener('click', this.onPauseButton);
      options.play.hud.centerButton.addEventListener('click', this.onCenterButton);
      options.play.hud.speedButton.addEventListener('click', this.onSpeedButton);
      options.play.hud.speed = 1;
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
    window.clearTimeout(this.tipTimer);
    this.resizeObserver.disconnect();
    this.input?.dispose();
    window.removeEventListener('keydown', this.onKey);
    this.options.play?.hud.pauseButton.removeEventListener('click', this.onPauseButton);
    this.options.play?.hud.centerButton.removeEventListener('click', this.onCenterButton);
    this.options.play?.hud.speedButton.removeEventListener('click', this.onSpeedButton);
    this.options.play?.hud.minimap.removeEventListener('pointerdown', this.onMinimap);
    this.options.play?.hud.minimap.removeEventListener('pointermove', this.onMinimap);
    this.options.play?.hud.showTip(null);
    this.options.play?.tutorial?.hide();
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
      this.backlog += dt * this.speed;
      const maxSteps = 4 * this.speed;
      let steps = 0;
      while (this.backlog >= TICK_MS && steps < maxSteps) {
        this.feedReplay();
        this.game.step();
        this.backlog -= TICK_MS;
        steps++;
      }
      if (steps === maxSteps) this.backlog = 0;
      if (steps > 0) this.history.record(this.game);
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
      this.fog?.update();
      this.sinceLabels = 0;
    }
    this.renderer.labels.animate(dt / 1000);
    this.renderer.render(this.camera, this.overlayState());

    this.sinceHud += dt;
    if (this.options.play && this.me && this.sinceHud > 150) {
      this.sinceHud = 0;
      this.options.play.hud.update(this.game, this.me);
      this.options.play.hud.updateTools(this.game, this.me, this.tool);
      this.updateOffer();
      this.options.play.tutorial?.update(this.game, this.me);
      this.coach(now);
      this.drawMinimap();
      this.updateTip();
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
    if (kind === 'warship') {
      const refusal = game.canWarship(me);
      const afloat = game.warships.some((s) => s.owner === me.id);
      if (refusal === 'noPort' && !afloat) return 'Bau zuerst einen Hafen. Kriegsschiffe laufen von dort aus.';
      if (refusal === 'gold' && !afloat) return `Ein Kriegsschiff kostet ${formatTroops(CONFIG.warship.cost)} Gold.`;
      if (tile >= 0 && !game.isWater(tile)) return 'Klick aufs Wasser: dorthin fährt dein Kriegsschiff.';
      return null;
    }
    if (isMissile(kind)) {
      const refusal = game.canLaunch(me, kind);
      if (refusal === 'noSilo') return 'Bau zuerst ein Raketensilo.';
      if (refusal === 'reloading') return 'Deine Silos laden nach. Jedes Silo kann alle 10 Sekunden feuern.';
      if (refusal === 'silos') return `Für eine H-Bombe brauchst du ${CONFIG.hbombSilos} Raketensilos.`;
      if (refusal === 'gold') return `${{ rocket: 'Eine Rakete', nuke: 'Eine Atombombe', hbomb: 'Eine H-Bombe' }[kind]} kostet ${formatTroops(game.missileCost(kind))} Gold.`;
      if (tile >= 0 && game.allied(me.id, game.owner[tile])) return 'Du kannst nicht auf Verbündete schießen.';
      return null;
    }
    if (tile < 0) {
      if (me.owned[kind] >= game.buildLimit(me, kind)) return this.limitText(kind);
      return me.gold < game.buildCost(me, kind) ? `Das kostet ${formatTroops(game.buildCost(me, kind))} Gold.` : null;
    }
    switch (game.canBuild(me, kind, tile)) {
      case 'gold':
        return `Das kostet ${formatTroops(game.buildCost(me, kind))} Gold.`;
      case 'notYours':
      case 'offMap':
        return 'Bau auf deinem eigenen Land.';
      case 'notCoast':
        return 'Häfen müssen direkt am Wasser stehen.';
      case 'limit':
        return this.limitText(kind);
      case 'tooClose':
        return 'Zu nah an einem anderen Gebäude. Lass 4 Felder Abstand.';
      default:
        return null;
    }
  }

  private limitText(kind: BuildingKind): string {
    const per = formatCount(CONFIG.tilesPerBuilding[kind]);
    return `Mehr davon geht erst mit mehr Land: 2 plus 1 je ${per} Felder.`;
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
      kind === 'warship'
        ? `Klick aufs Wasser: ${this.game.canWarship(this.me) === null ? 'Ein neues Kriegsschiff läuft dorthin aus.' : 'Dein nächstes Kriegsschiff fährt dorthin.'} ${cancel}`
        : kind === 'ally'
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
    if (kind === 'warship') {
      this.game.queue({ type: 'warship', player: me.id, tile });
      sound.play('click');
      this.cancel();
      return;
    }
    if (kind === 'ally' && this.game.teammates(me.id, this.game.owner[tile])) {
      this.game.queue({ type: 'donate', player: me.id, target: this.game.owner[tile], troops: 0, gold: Math.floor(me.gold / 3) });
      sound.play('click');
      this.cancel();
      return;
    }
    if (kind === 'ally') {
      const target = this.game.owner[tile];
      if (this.game.allied(me.id, target)) this.game.queue({ type: 'breakAlly', player: me.id, target });
      else this.game.queue({ type: 'ally', player: me.id, target });
    } else if (isMissile(kind)) this.game.queue({ type: 'launch', player: me.id, tile, kind });
    else {
      this.game.queue({ type: 'build', player: me.id, tile, kind });
      sound.play('build');
    }
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
    sound.play('click');
  }

  private canSpawnAt(tile: number): boolean {
    return this.game.isLand(tile) && this.game.map.terrain[tile] !== Terrain.Mountains;
  }

  // Input

  tap(sx: number, sy: number): void {
    // On touch screens there is no hover: show the info card for a few seconds where you tapped.
    this.hover(sx, sy);
    window.clearTimeout(this.tipTimer);
    this.tipTimer = window.setTimeout(() => this.leave(), 3000);
    const { game, me } = this;
    const hud = this.options.play?.hud;
    if (!me || !hud || this.paused || hud.overlayOpen || this.replay) return;
    const tile = this.camera.tileAt(sx, sy, game.width, game.height);
    if (tile < 0) return;

    if (game.phase === 'spawn') {
      if (!game.isLand(tile)) hud.toast('Wähl eine Stelle an Land.');
      else if (!this.canSpawnAt(tile)) hud.toast('Auf Bergen wächst man zu langsam. Wähl tieferes Land.');
      else {
        game.queue({ type: 'spawn', player: me.id, tile });
        hud.setBanner('');
        sound.play('build');
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
    if (game.teammates(me.id, target)) {
      if (me.troops < 2) {
        hud.toast('Du hast noch keine Truppen zum Verschicken.');
        return;
      }
      game.queue({ type: 'donate', player: me.id, target, troops: hud.percent * 10, gold: 0 });
      sound.play('click');
      return;
    }
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
    sound.play('click');
  }

  hover(sx: number, sy: number): void {
    this.hoverTile = this.camera.tileAt(sx, sy, this.game.width, this.game.height);
    const rect = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / Math.max(1, rect.width);
    this.tipAt = { x: rect.left + sx / k, y: rect.top + sy / k };
    this.updateTip();
  }

  leave(): void {
    this.hoverTile = -1;
    this.tipAt = null;
    this.options.play?.hud.showTip(null);
  }

  /** Who holds the land under the cursor, and what taking it would cost. */
  private updateTip(): void {
    const hud = this.options.play?.hud;
    const { game, me } = this;
    if (!hud || !me || !this.tipAt) return;
    const t = this.hoverTile;
    if (t < 0 || !game.isLand(t) || game.phase !== 'play') {
      hud.showTip(null);
      return;
    }
    const o = game.owner[t];
    const kind = game.map.terrain[t];
    const ground = kind === Terrain.Mountains ? 'Gebirge (sehr langsam)' : kind === Terrain.Highlands ? 'Hügel (langsam)' : 'Flachland';
    const lines: string[] = [];
    if (this.fog?.hidden(t)) {
      hud.showTip(['Im Nebel', 'Unbekanntes Gebiet'], this.tipAt.x, this.tipAt.y);
      return;
    }
    if (o === NEUTRAL) {
      lines.push('Freies Land', ground);
    } else {
      const p = game.player(o);
      lines.push(o === me.id ? `${p.name} (du)` : p.name);
      lines.push(`${formatTroops(p.troops)} Truppen · ${formatShare(p.tiles / game.map.landTiles)} Land`);
      if (game.teammates(me.id, o)) lines.push('Dein Team: Klick schickt Truppen, Bündnis-Werkzeug (H) ein Drittel deines Golds');
      else if (game.allied(me.id, o)) lines.push(`Verbündet, noch ${formatClock((game.allianceEnds(me.id, o) - game.tick) / CONFIG.ticksPerSecond)}`);
      lines.push(ground);
    }
    if (o !== me.id && !game.allied(me.id, o) && me.alive) {
      lines.push(`Kostet etwa ${formatTroops(game.costToTake(t, me.id))} Truppen pro Feld`);
    }
    hud.showTip(lines, this.tipAt.x, this.tipAt.y);
  }

  /** The whole map in the corner, with a frame for what's on screen. */
  private drawMinimap(): void {
    const mini = this.options.play?.hud.minimap;
    if (!mini || mini.offsetWidth === 0) return;
    // Drawn at the size it appears on screen, so a scaled-up UI stays sharp.
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * uiScale());
    const w = Math.round(mini.clientWidth * dpr);
    const h = Math.round((w * this.game.height) / this.game.width);
    if (mini.width !== w || mini.height !== h) {
      mini.width = w;
      mini.height = h;
      mini.style.height = `${(mini.clientWidth * this.game.height) / this.game.width}px`;
    }
    const ctx = mini.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.renderer.mapImage, 0, 0, w, h);
    this.fog?.draw(ctx, 0, 0, w / this.game.width);
    const k = w / this.game.width;
    const cam = this.camera;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeRect((-cam.x / cam.scale) * k, (-cam.y / cam.scale) * k, (this.canvas.width / cam.scale) * k, (this.canvas.height / cam.scale) * k);
  }

  private onMinimap = (e: PointerEvent): void => {
    if (e.type === 'pointermove' && e.buttons === 0) return;
    const mini = e.currentTarget as HTMLCanvasElement;
    const rect = mini.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.game.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.game.height;
    this.flight = null;
    this.camera.centerOn(x, y, this.canvas.width, this.canvas.height);
    this.moved();
    this.drawMinimap();
  };

  moved(): void {
    this.flight = null;
    this.camera.clamp(this.canvas.width, this.canvas.height, this.game.width, this.game.height);
  }

  private onKey = (e: KeyboardEvent): void => {
    const hud = this.options.play?.hud;
    if (!hud || e.ctrlKey || e.metaKey || e.altKey || !byId('settings').hidden) return;
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (e.key === 'Escape' && this.tool) {
      this.cancel();
      return;
    }
    const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
    if (tool && !hud.overlayOpen && !this.replay) {
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
    } else if (e.key === 'x' || e.key === 'X') {
      this.cycleSpeed();
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

  /** Newcomer tips, each the first time it applies (and only while playing, not replaying). */
  private coach(now: number): void {
    const { game, me } = this;
    const hud = this.options.play?.hud;
    if (!hud || !me || this.replay || !me.alive || game.phase !== 'play' || this.paused) return;
    // The tutorial does the explaining while it runs.
    if (this.options.play?.tutorial?.active) return;
    // One at a time, a few seconds apart.
    const tip = (id: TipId, when: boolean) => {
      if (!when || now - this.lastTip < 9000 || !takeTip(id)) return;
      this.lastTip = now;
      hud.post(TIPS[id], 'tip');
    };
    const since = now - this.spawnedAt;
    tip('expand', since > 1500);
    tip('zoom', since > 15000);
    tip('city', since > 8000 && me.gold >= game.buildCost(me, 'city'));
    tip('full', me.troops > game.maxTroops(me) * 0.9);
    tip('neighbour', since > 20000 && game.players.some((p) => p.id !== me.id && p.alive && !game.allied(me.id, p.id) && game.sharesBorder(me, p.id)));
    tip('attacked', game.attacks.some((a) => a.target === me.id));
  }

  /** Keeps the alliance offer card's countdown current, and removes it once the offer is gone. */
  private updateOffer(): void {
    const hud = this.options.play?.hud;
    if (!hud || !this.me || !hud.offerFrom) return;
    const lapses = this.game.offerLapses(hud.offerFrom, this.me.id);
    if (lapses <= this.game.tick || !this.game.player(hud.offerFrom).alive) hud.hideOffer();
    else hud.showOffer(this.game.player(hud.offerFrom), Math.ceil((lapses - this.game.tick) / CONFIG.ticksPerSecond));
  }

  /** Queues the recorded intents due on the coming tick. */
  private feedReplay(): void {
    const log = this.replay;
    if (!log) return;
    while (this.replayAt < log.length && log[this.replayAt].tick <= this.game.tick) {
      this.game.queue(log[this.replayAt++].intent);
    }
  }

  private onSpeedButton = (): void => this.cycleSpeed();

  private cycleSpeed(): void {
    const hud = this.options.play?.hud;
    if (!hud || this.ended) return;
    const speeds = this.replay ? REPLAY_SPEEDS : SPEEDS;
    this.speed = speeds[(speeds.indexOf(this.speed) + 1) % speeds.length];
    hud.speed = this.speed;
  }

  private togglePause(): void {
    const play = this.options.play;
    if (!play || this.ended || (this.defeatShown && play.hud.overlayOpen)) return;
    this.paused = !this.paused;
    if (!this.paused) {
      play.hud.hideOverlay();
      return;
    }
    if (this.replay) {
      play.hud.showOverlay({
        eyebrow: 'Wiederholung',
        title: 'Angehalten',
        text: `Bei ${this.matchTime()}.`,
        stats: [],
        actions: [
          { label: 'Weiter', primary: true, run: () => this.togglePause() },
          { label: 'Zum Menü', run: () => play.hooks.menu() },
        ],
      });
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
    const name = (id: number) => (id === me.id ? 'du' : id === NEUTRAL ? 'die Flut' : this.game.player(id).name);
    // Many buildings can change hands at once: report them together.
    const captures = new Map<string, number>();
    for (const e of events) {
      if (e.type !== 'captured' || (e.by !== me.id && e.from !== me.id)) continue;
      const key = `${e.by}:${e.from}`;
      captures.set(key, (captures.get(key) ?? 0) + 1);
    }
    for (const [key, n] of captures) {
      const [by, from] = key.split(':').map(Number);
      const what = n === 1 ? 'ein Gebäude' : `${n} Gebäude`;
      if (by === me.id) hud.post(`Du hast ${what} von ${name(from)} erobert.`, 'good');
      else hud.post(`${name(by)} hat ${what} von dir erobert.`, 'bad');
    }
    for (const e of events) {
      if (e.type === 'capitalLost') {
        if (e.player === me.id) hud.post(`${name(e.by)} hat deine Hauptstadt erobert. Du hast die Hälfte deiner Truppen verloren.`, 'bad');
        else if (e.by === me.id) hud.post(`Du hast die Hauptstadt von ${name(e.player)} erobert. Sie verlieren die Hälfte ihrer Truppen.`, 'good');
      } else if (e.type === 'eliminated') {
        if (e.player === me.id && this.replay) hud.post(`${name(e.by)} hat dich ausgelöscht.`, 'bad');
        else if (e.player === me.id) this.showDefeat(e.by);
        else if (e.by === me.id) hud.post(`Du hast ${name(e.player)} ausgelöscht.`, 'good');
        else hud.post(`${name(e.by)} hat ${name(e.player)} ausgelöscht.`, 'info');
      } else if (e.type === 'encircled') {
        if (e.player === me.id) hud.post(`${name(e.by)} hat ${e.tiles} deiner Felder abgeschnitten und übernommen.`, 'bad');
        else if (e.by === me.id) hud.post(`Du hast ${e.tiles} Felder von ${name(e.player)} abgeschnitten und übernommen.`, 'good');
      } else if (e.type === 'captured') {
        // Reported together above.
      } else if (e.type === 'bunkerDestroyed') {
        if (e.by === me.id) hud.post(`Du hast einen Bunker von ${name(e.from)} zerstört.`, 'good');
        else if (e.from === me.id) hud.post(`${name(e.by)} hat einen deiner Bunker zerstört.`, 'bad');
      } else if (e.type === 'trainStop') {
        if (e.owner === me.id) {
          this.renderer.floatText(e.tile, `+${formatTroops(e.gold)}`);
          sound.play('train', 0.5);
        }
      } else if (e.type === 'landed') {
        if (e.owner === me.id) hud.post(e.target === NEUTRAL ? 'Deine Truppen sind gelandet.' : `Deine Truppen sind bei ${name(e.target)} gelandet.`, 'good');
        else if (e.target === me.id) hud.post(`${name(e.owner)} ist an deiner Küste gelandet!`, 'bad');
      } else if (e.type === 'repelled') {
        if (e.owner === me.id) hud.post('Deine Landung wurde abgewehrt.', 'bad');
        else if (e.target === me.id) hud.post(`Du hast eine Landung von ${name(e.owner)} abgewehrt.`, 'good');
      } else if (e.type === 'alliance') {
        if (e.from === me.id) hud.post(e.accepted ? `${name(e.to)} ist jetzt dein Verbündeter (3 Minuten).` : `${name(e.to)} lehnt ein Bündnis ab. Versuch es später nochmal.`, e.accepted ? 'good' : 'info');
        else if (e.to === me.id && e.accepted) hud.post(`${name(e.from)} ist jetzt dein Verbündeter.`, 'good');
      } else if (e.type === 'allianceOffer') {
        if (e.to === me.id && !this.replay) {
          hud.showOffer(this.game.player(e.from), Math.round(CONFIG.allianceOfferTicks / CONFIG.ticksPerSecond));
          sound.play('alliance');
        }
      } else if (e.type === 'allianceEnded') {
        const other = e.a === me.id ? e.b : e.b === me.id ? e.a : NEUTRAL;
        if (other !== NEUTRAL) {
          if (e.brokenBy === me.id) hud.post(`Du hast das Bündnis mit ${name(other)} beendet.`, 'info');
          else if (e.brokenBy === other) hud.post(`${name(other)} hat das Bündnis gebrochen!`, 'bad');
          else hud.post(`Das Bündnis mit ${name(other)} ist abgelaufen.`, 'info');
        }
      } else if (e.type === 'launched') {
        const m = e.missile;
        sound.play('launch', m.owner === me.id ? 1 : m.victim === me.id ? 0.7 : 0.15);
      } else if (e.type === 'impact') {
        const m = e.missile;
        const mine = m.owner === me.id || e.losses.some((l) => l.player === me.id);
        sound.play(m.kind === 'rocket' ? 'boom' : 'bigBoom', mine ? 1 : 0.25);
      } else if (e.type === 'sunk') {
        if (e.by === me.id) hud.post(`Dein Kriegsschiff hat ein Boot von ${name(e.owner)} versenkt (${formatTroops(e.troops)} Truppen).`, 'good');
        else if (e.owner === me.id) hud.post(`${name(e.by)} hat dein Boot versenkt!`, 'bad');
      } else if (e.type === 'shipSunk') {
        if (e.by === me.id) hud.post(`Du hast ein Kriegsschiff von ${name(e.owner)} versenkt.`, 'good');
        else if (e.owner === me.id) hud.post(`${name(e.by)} hat dein Kriegsschiff versenkt!`, 'bad');
        this.renderer.shellHit(e.tile);
      } else if (e.type === 'shelled') {
        this.renderer.shellHit(e.tile);
        if (e.by === me.id || e.owner === me.id) sound.play('boom', 0.35);
        // Once in a while, not for every shell.
        if (e.owner === me.id && performance.now() - this.lastShellNote > 15000) {
          this.lastShellNote = performance.now();
          hud.post(`Ein Kriegsschiff von ${name(e.by)} beschießt deine Küste!`, 'bad');
        }
      } else if (e.type === 'donated') {
        const what = [e.troops > 0 ? `${formatTroops(e.troops)} Truppen` : '', e.gold > 0 ? `${formatTroops(e.gold)} Gold` : ''].filter(Boolean).join(' und ');
        if (e.to === me.id) hud.post(`${name(e.from)} schickt dir ${what}.`, 'good');
        else if (e.from === me.id) hud.toast(`Du hast ${name(e.to)} ${what} geschickt.`);
      } else if (e.type === 'flooded') {
        this.renderer.flood(e.tiles);
        if (!this.floodAnnounced) {
          this.floodAnnounced = true;
          hud.post('Das Meer steigt! Rot markiertes Land geht in 20 Sekunden unter.', 'bad');
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
      ['Platz', `${place}/${this.game.players.length}`],
      ['Meistes Land', formatShare(me.peakTiles / this.game.map.landTiles)],
      ['Zeit', this.matchTime()],
    ];
  }

  /** The land-over-time chart for the results screen, once there is enough history. */
  private chart(): HTMLElement | null {
    const data = chartData(this.game, this.history, this.me?.id ?? null);
    return data ? landChart(data) : null;
  }

  private showDefeat(by: number): void {
    const play = this.options.play!;
    this.defeatShown = true;
    sound.play('lose');
    if (!this.replay && !this.resultReported) {
      this.resultReported = true;
      play.hooks.result?.(false, this.game.tick / CONFIG.ticksPerSecond);
    }
    play.hud.showOverlay({
      eyebrow: 'Niederlage',
      title: 'Ausgeschieden',
      text: `${this.game.player(by).name} hat nach ${this.matchTime()} dein letztes Feld erobert.`,
      stats: this.stats(),
      extra: this.chart(),
      actions: [
        { label: 'Nochmal spielen', primary: true, run: () => play.hooks.playAgain() },
        { label: 'Weiter zuschauen', run: () => play.hud.hideOverlay() },
        { label: 'Wiederholung', run: () => play.hooks.replay(this.game.log.slice()) },
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
    if (me.alive) sound.play(winnerId === me.id || (this.game.teamGame && winner.team === me.team) ? 'win' : 'lose');

    let eyebrow: string;
    let title: string;
    let text: string;
    if (this.game.teamGame) {
      const won = winner.team === me.team;
      const teamShare = formatShare((this.game.teamTiles()[winner.team] ?? 0) / this.game.map.landTiles);
      eyebrow = won ? 'Sieg' : me.alive ? 'Niederlage' : 'Partie vorbei';
      title = won ? 'Dein Team gewinnt' : `Team ${winner.name} gewinnt`;
      text = `${won ? 'Deinem Team' : `Team ${winner.name}`} gehören ${timed ? 'zum Schluss ' : `nach ${this.matchTime()} `}${teamShare} des Landes.`;
    } else if (winnerId === me.id) {
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
    if (this.replay) eyebrow = 'Ende der Wiederholung';
    else if (!this.resultReported) {
      this.resultReported = true;
      const won = winnerId === me.id || (this.game.teamGame && winner.team === me.team);
      const note = play.hooks.result?.(won, this.game.tick / CONFIG.ticksPerSecond);
      if (note) text = `${text} ${note}`;
    }
    play.hud.showOverlay({
      eyebrow,
      title,
      text,
      stats: this.stats(),
      extra: this.chart(),
      actions: [
        { label: 'Nochmal spielen', primary: true, run: () => play.hooks.playAgain() },
        { label: this.replay ? 'Nochmal ansehen' : 'Wiederholung', run: () => play.hooks.replay((this.replay ?? this.game.log).slice()) },
        { label: 'Menü', run: () => play.hooks.menu() },
      ],
    });
  }
}
