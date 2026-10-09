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
import { click, t, touch } from './i18n';
import { share, shareNote } from './share';
import { takeTip, TIPS, type TipId } from './tips';
import type { Tutorial } from './tutorial';
import { unlock } from './achievements';
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
  play?: { hud: Hud; hooks: SessionHooks; replay?: IntentLog; fog?: boolean; tutorial?: Tutorial; title?: string };
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
        options.play?.hud.toast(t('Truppen zurückgerufen.', 'Troops recalled.'));
      };
      options.play.hud.onOffer = (from, accept) => {
        if (!this.me || this.replay) return;
        if (accept) this.game.queue({ type: 'ally', player: this.me.id, target: from });
        else options.play?.hud.toast(t(`Du hast ${this.game.player(from).name} abgewiesen.`, `You turned down ${this.game.player(from).name}.`));
      };
      options.play.hud.minimap.addEventListener('pointerdown', this.onMinimap);
      options.play.hud.minimap.addEventListener('pointermove', this.onMinimap);
      options.play.hud.show(this.me);
      options.play.hud.root.classList.toggle('replay', this.replay !== null);
      // The tutorial card explains the start itself.
      options.play.hud.setBanner(this.replay || options.play.tutorial ? '' : t(`${click} auf eine beliebige Stelle an Land, um dort zu starten.`, `${click} anywhere on land to start there.`));
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
    if (!me || game.phase !== 'play' || !me.alive) return t('Warte, bis die Partie läuft.', 'Wait until the match is running.');
    if (kind === 'ally') {
      if (tile < 0) return null;
      const o = game.owner[tile];
      if (o === NEUTRAL || o === me.id) return t(`${click} auf das Land eines anderen Spielers.`, `${click} another player's land.`);
      return null;
    }
    if (kind === 'warship') {
      const refusal = game.canWarship(me);
      const afloat = game.warships.some((s) => s.owner === me.id);
      if (refusal === 'noPort' && !afloat) return t('Bau zuerst einen Hafen. Kriegsschiffe laufen von dort aus.', 'Build a port first. Warships sail from there.');
      if (refusal === 'gold' && !afloat) return t(`Ein Kriegsschiff kostet ${formatTroops(CONFIG.warship.cost)} Gold.`, `A warship costs ${formatTroops(CONFIG.warship.cost)} gold.`);
      if (tile >= 0 && !game.isWater(tile)) return t(`${click} aufs Wasser: dorthin fährt dein Kriegsschiff.`, `${click} the water: your warship sails there.`);
      return null;
    }
    if (isMissile(kind)) {
      const refusal = game.canLaunch(me, kind);
      if (refusal === 'noSilo') return t('Bau zuerst ein Raketensilo.', 'Build a missile silo first.');
      if (refusal === 'reloading') return t('Deine Silos laden nach. Jedes Silo kann alle 10 Sekunden feuern.', 'Your silos are reloading. Each silo can fire every 10 seconds.');
      if (refusal === 'silos') return t(`Für eine H-Bombe brauchst du ${CONFIG.hbombSilos} Raketensilos.`, `A hydrogen bomb needs ${CONFIG.hbombSilos} missile silos.`);
      if (refusal === 'gold') return t(`${{ rocket: 'Eine Rakete', nuke: 'Eine Atombombe', hbomb: 'Eine H-Bombe' }[kind]} kostet ${formatTroops(game.missileCost(kind))} Gold.`, `${{ rocket: 'A rocket', nuke: 'A nuke', hbomb: 'A hydrogen bomb' }[kind]} costs ${formatTroops(game.missileCost(kind))} gold.`);
      if (tile >= 0 && game.allied(me.id, game.owner[tile])) return t('Du kannst nicht auf Verbündete schießen.', 'You can\'t fire at allies.');
      return null;
    }
    if (tile < 0) {
      if (me.owned[kind] >= game.buildLimit(me, kind)) return this.limitText(kind);
      return me.gold < game.buildCost(me, kind) ? t(`Das kostet ${formatTroops(game.buildCost(me, kind))} Gold.`, `That costs ${formatTroops(game.buildCost(me, kind))} gold.`) : null;
    }
    switch (game.canBuild(me, kind, tile)) {
      case 'gold':
        return t(`Das kostet ${formatTroops(game.buildCost(me, kind))} Gold.`, `That costs ${formatTroops(game.buildCost(me, kind))} gold.`);
      case 'notYours':
      case 'offMap':
        return t('Bau auf deinem eigenen Land.', 'Build on your own land.');
      case 'notCoast':
        return t('Häfen müssen direkt am Wasser stehen.', 'Ports must stand right by the water.');
      case 'limit':
        return this.limitText(kind);
      case 'tooClose':
        return t('Zu nah an einem anderen Gebäude. Lass 4 Felder Abstand.', 'Too close to another building. Leave 4 tiles between them.');
      default:
        return null;
    }
  }

  private limitText(kind: BuildingKind): string {
    const per = formatCount(CONFIG.tilesPerBuilding[kind]);
    return t(`Mehr davon geht erst mit mehr Land: 2 plus 1 je ${per} Felder.`, `You need more land for more of these: 2, plus 1 per ${per} tiles.`);
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
      city: t('eine Stadt', 'a city'),
      factory: t('eine Fabrik', 'a factory'),
      port: t('einen Hafen (an der Küste)', 'a port (on the coast)'),
      defense: t('einen Bunker', 'a bunker'),
      silo: t('ein Raketensilo', 'a missile silo'),
    };
    const cancel = touch ? t('Tippe das Werkzeug noch mal an, um abzubrechen.', 'Tap the tool again to cancel.') : t('Rechtsklick oder Esc bricht ab.', 'Right-click or Esc cancels.');
    hud.setBanner(
      kind === 'warship'
        ? `${t(`${click} aufs Wasser:`, `${click} the water:`)} ${this.game.canWarship(this.me) === null ? t('Ein neues Kriegsschiff läuft dorthin aus.', 'A new warship sails there.') : t('Dein nächstes Kriegsschiff fährt dorthin.', 'Your nearest warship heads there.')} ${cancel}`
        : kind === 'ally'
        ? t(`${click} auf das Land eines Spielers für ein Bündnis (oder um eins zu beenden). ${cancel}`, `${click} a player's land to offer an alliance (or to end one). ${cancel}`)
        : isMissile(kind)
          ? t(`${click} auf ein Ziel für deine ${name}. ${cancel}`, `${click} a target for your ${name}. ${cancel}`)
          : t(`${click} auf dein Land, um ${building[kind]} zu bauen. ${cancel}`, `${click} your land to build ${building[kind]}. ${cancel}`),
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
      noPort: t('Dieses Land grenzt nicht an deins. Mit einem Hafen kannst du übers Wasser übersetzen.', 'This land doesn\'t border yours. With a port you can cross the water.'),
      boats: t(`Du hast schon ${CONFIG.maxBoats} Boote unterwegs.`, `You already have ${CONFIG.maxBoats} boats at sea.`),
      ally: t('Dort wohnt ein Verbündeter.', 'An ally lives there.'),
      noRoute: t('Kein Seeweg von deinen Häfen zu dieser Küste.', 'No sea route from your ports to that coast.'),
      offMap: t('Ziel auf Land.', 'Aim at land.'),
    };
    if (typeof plan === 'string') {
      hud.toast(why[plan] ?? t('Dorthin kann kein Boot fahren.', 'No boat can go there.'));
      return;
    }
    if (me.troops < 2) {
      hud.toast(t('Du hast noch keine Truppen zum Losschicken.', 'You have no troops to send yet.'));
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
      if (!game.isLand(tile)) hud.toast(t('Wähl eine Stelle an Land.', 'Pick a spot on land.'));
      else if (!this.canSpawnAt(tile)) hud.toast(t('Auf Bergen wächst man zu langsam. Wähl tieferes Land.', 'Mountains grow too slowly. Pick lower ground.'));
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
      hud.toast(t(`${click} auf Land jenseits des Wassers. Boote brauchen einen Hafen.`, `${click} land across the water. Boats need a port.`));
      return;
    }
    const target = game.owner[tile];
    if (target === me.id) return;
    if (game.teammates(me.id, target)) {
      if (me.troops < 2) {
        hud.toast(t('Du hast noch keine Truppen zum Verschicken.', 'You have no troops to send yet.'));
        return;
      }
      game.queue({ type: 'donate', player: me.id, target, troops: hud.percent * 10, gold: 0 });
      sound.play('click');
      return;
    }
    if (game.allied(me.id, target)) {
      hud.toast(t(`${game.player(target).name} ist dein Verbündeter.`, `${game.player(target).name} is your ally.`));
      return;
    }
    if (!game.sharesBorder(me, target)) {
      if (me.owned.port > 0) this.sendBoat(tile);
      else hud.toast(target === NEUTRAL ? t('Dieses Land grenzt nicht an deins. Mit einem Hafen kommst du übers Wasser.', 'This land doesn\'t border yours. A port gets you across the water.') : t(`Du hast keine gemeinsame Grenze mit ${game.player(target).name}.`, `You don\'t share a border with ${game.player(target).name}.`));
      return;
    }
    if (me.troops < 2) {
      hud.toast(t('Du hast noch keine Truppen zum Losschicken.', 'You have no troops to send yet.'));
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
    const tile = this.hoverTile;
    if (tile < 0 || !game.isLand(tile) || game.phase !== 'play') {
      hud.showTip(null);
      return;
    }
    const o = game.owner[tile];
    const kind = game.map.terrain[tile];
    const ground = kind === Terrain.Mountains ? t('Gebirge (sehr langsam)', 'Mountains (very slow)') : kind === Terrain.Highlands ? t('Hügel (langsam)', 'Hills (slow)') : t('Flachland', 'Plains');
    const lines: string[] = [];
    if (this.fog?.hidden(tile)) {
      hud.showTip([t('Im Nebel', 'In the fog'), t('Unbekanntes Gebiet', 'Unknown land')], this.tipAt.x, this.tipAt.y);
      return;
    }
    if (o === NEUTRAL) {
      lines.push(t('Freies Land', 'Free land'), ground);
    } else {
      const p = game.player(o);
      lines.push(o === me.id ? t(`${p.name} (du)`, `${p.name} (you)`) : p.name);
      lines.push(t(`${formatTroops(p.troops)} Truppen · ${formatShare(p.tiles / game.map.landTiles)} Land`, `${formatTroops(p.troops)} troops · ${formatShare(p.tiles / game.map.landTiles)} land`));
      if (game.teammates(me.id, o)) lines.push(t(`Dein Team: ${touch ? 'Antippen' : 'Klick'} schickt Truppen, Bündnis-Werkzeug (H) ein Drittel deines Golds`, `Your team: ${click.toLowerCase()} to send troops, alliance tool (H) gives a third of your gold`));
      else if (game.allied(me.id, o)) lines.push(t(`Verbündet, noch ${formatClock((game.allianceEnds(me.id, o) - game.tick) / CONFIG.ticksPerSecond)}`, `Allied for another ${formatClock((game.allianceEnds(me.id, o) - game.tick) / CONFIG.ticksPerSecond)}`));
      lines.push(ground);
    }
    if (o !== me.id && !game.allied(me.id, o) && me.alive) {
      lines.push(t(`Kostet etwa ${formatTroops(game.costToTake(tile, me.id))} Truppen pro Feld`, `Costs about ${formatTroops(game.costToTake(tile, me.id))} troops a tile`));
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
    if (me.owned.city >= 10) unlock('tenCities');
    if (me.tiles * 2 >= game.map.landTiles) unlock('half');
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
        eyebrow: t('Wiederholung', 'Replay'),
        title: t('Angehalten', 'Paused'),
        text: `Bei ${this.matchTime()}.`,
        stats: [],
        actions: [
          { label: t('Weiter', 'Continue'), primary: true, run: () => this.togglePause() },
          { label: t('Zum Menü', 'Menu'), run: () => play.hooks.menu() },
        ],
      });
      return;
    }
    play.hud.showOverlay({
      eyebrow: 'Pause',
      title: t('Spiel pausiert', 'Game paused'),
      text: t('Nichts bewegt sich, bis du weiterspielst.', 'Nothing moves until you carry on.'),
      stats: [],
      actions: [
        { label: t('Weiter', 'Continue'), primary: true, run: () => this.togglePause() },
        { label: t('Neue Karte', 'New map'), run: () => play.hooks.playAgain() },
        { label: t('Zum Menü', 'Menu'), run: () => play.hooks.menu() },
      ],
    });
  }

  private handleEvents(events: GameEvent[]): void {
    const hud = this.options.play!.hud;
    const me = this.me!;
    const name = (id: number) => (id === me.id ? t('du', 'you') : id === NEUTRAL ? t('die Flut', 'the flood') : this.game.player(id).name);
    // Many buildings can change hands at once: report them together.
    const captures = new Map<string, number>();
    for (const e of events) {
      if (e.type !== 'captured' || (e.by !== me.id && e.from !== me.id)) continue;
      const key = `${e.by}:${e.from}`;
      captures.set(key, (captures.get(key) ?? 0) + 1);
    }
    for (const [key, n] of captures) {
      const [by, from] = key.split(':').map(Number);
      const what = n === 1 ? t('ein Gebäude', 'a building') : t(`${n} Gebäude`, `${n} buildings`);
      if (by === me.id) hud.post(t(`Du hast ${what} von ${name(from)} erobert.`, `You captured ${what} from ${name(from)}.`), 'good');
      else hud.post(t(`${name(by)} hat ${what} von dir erobert.`, `${name(by)} captured ${what} from you.`), 'bad');
    }
    for (const e of events) {
      if (e.type === 'capitalLost') {
        if (e.player === me.id) hud.post(t(`${name(e.by)} hat deine Hauptstadt erobert. Du hast die Hälfte deiner Truppen verloren.`, `${name(e.by)} took your capital. You lost half your troops.`), 'bad');
        else if (e.by === me.id && !this.replay) unlock('capital');
        if (e.by === me.id) hud.post(t(`Du hast die Hauptstadt von ${name(e.player)} erobert. Sie verlieren die Hälfte ihrer Truppen.`, `You took ${name(e.player)}\'s capital. They lose half their troops.`), 'good');
      } else if (e.type === 'eliminated') {
        if (e.player === me.id && this.replay) hud.post(t(`${name(e.by)} hat dich ausgelöscht.`, `${name(e.by)} wiped you out.`), 'bad');
        else if (e.player === me.id) this.showDefeat(e.by);
        else if (e.by === me.id) hud.post(t(`Du hast ${name(e.player)} ausgelöscht.`, `You wiped out ${name(e.player)}.`), 'good');
        else hud.post(t(`${name(e.by)} hat ${name(e.player)} ausgelöscht.`, `${name(e.by)} wiped out ${name(e.player)}.`), 'info');
      } else if (e.type === 'encircled') {
        if (e.player === me.id) hud.post(t(`${name(e.by)} hat ${e.tiles} deiner Felder abgeschnitten und übernommen.`, `${name(e.by)} cut off and took ${e.tiles} of your tiles.`), 'bad');
        else if (e.by === me.id) hud.post(t(`Du hast ${e.tiles} Felder von ${name(e.player)} abgeschnitten und übernommen.`, `You cut off and took ${e.tiles} tiles from ${name(e.player)}.`), 'good');
      } else if (e.type === 'captured') {
        // Reported together above.
      } else if (e.type === 'bunkerDestroyed') {
        if (e.by === me.id) hud.post(t(`Du hast einen Bunker von ${name(e.from)} zerstört.`, `You destroyed a bunker of ${name(e.from)}.`), 'good');
        else if (e.from === me.id) hud.post(t(`${name(e.by)} hat einen deiner Bunker zerstört.`, `${name(e.by)} destroyed one of your bunkers.`), 'bad');
      } else if (e.type === 'trainStop') {
        if (e.owner === me.id) {
          this.renderer.floatText(e.tile, `+${formatTroops(e.gold)}`);
          sound.play('train', 0.5);
        }
      } else if (e.type === 'landed') {
        if (e.owner === me.id) hud.post(e.target === NEUTRAL ? t('Deine Truppen sind gelandet.', 'Your troops have landed.') : t(`Deine Truppen sind bei ${name(e.target)} gelandet.`, `Your troops have landed on ${name(e.target)}\'s shore.`), 'good');
        else if (e.target === me.id) hud.post(t(`${name(e.owner)} ist an deiner Küste gelandet!`, `${name(e.owner)} has landed on your coast!`), 'bad');
      } else if (e.type === 'repelled') {
        if (e.owner === me.id) hud.post(t('Deine Landung wurde abgewehrt.', 'Your landing was beaten back.'), 'bad');
        else if (e.target === me.id) hud.post(t(`Du hast eine Landung von ${name(e.owner)} abgewehrt.`, `You beat back a landing by ${name(e.owner)}.`), 'good');
      } else if (e.type === 'alliance') {
        if (e.from === me.id) hud.post(e.accepted ? t(`${name(e.to)} ist jetzt dein Verbündeter (3 Minuten).`, `${name(e.to)} is now your ally (3 minutes).`) : t(`${name(e.to)} lehnt ein Bündnis ab. Versuch es später nochmal.`, `${name(e.to)} turns down an alliance. Try again later.`), e.accepted ? 'good' : 'info');
        else if (e.to === me.id && e.accepted) hud.post(t(`${name(e.from)} ist jetzt dein Verbündeter.`, `${name(e.from)} is now your ally.`), 'good');
      } else if (e.type === 'allianceOffer') {
        if (e.to === me.id && !this.replay) {
          hud.showOffer(this.game.player(e.from), Math.round(CONFIG.allianceOfferTicks / CONFIG.ticksPerSecond));
          sound.play('alliance');
        }
      } else if (e.type === 'allianceEnded') {
        const other = e.a === me.id ? e.b : e.b === me.id ? e.a : NEUTRAL;
        if (other !== NEUTRAL) {
          if (e.brokenBy === me.id) hud.post(t(`Du hast das Bündnis mit ${name(other)} beendet.`, `You ended the alliance with ${name(other)}.`), 'info');
          else if (e.brokenBy === other) hud.post(t(`${name(other)} hat das Bündnis gebrochen!`, `${name(other)} broke the alliance!`), 'bad');
          else hud.post(t(`Das Bündnis mit ${name(other)} ist abgelaufen.`, `The alliance with ${name(other)} has run out.`), 'info');
        }
      } else if (e.type === 'launched') {
        const m = e.missile;
        if (m.owner === me.id && !this.replay && m.kind !== 'rocket') unlock(m.kind);
        sound.play('launch', m.owner === me.id ? 1 : m.victim === me.id ? 0.7 : 0.15);
      } else if (e.type === 'impact') {
        const m = e.missile;
        const mine = m.owner === me.id || e.losses.some((l) => l.player === me.id);
        sound.play(m.kind === 'rocket' ? 'boom' : 'bigBoom', mine ? 1 : 0.25);
      } else if (e.type === 'sunk') {
        if (e.by === me.id) hud.post(t(`Dein Kriegsschiff hat ein Boot von ${name(e.owner)} versenkt (${formatTroops(e.troops)} Truppen).`, `Your warship sank a boat of ${name(e.owner)} (${formatTroops(e.troops)} troops).`), 'good');
        else if (e.owner === me.id) hud.post(t(`${name(e.by)} hat dein Boot versenkt!`, `${name(e.by)} sank your boat!`), 'bad');
      } else if (e.type === 'shipSunk') {
        if (e.by === me.id && !this.replay) unlock('sinker');
        if (e.by === me.id) hud.post(t(`Du hast ein Kriegsschiff von ${name(e.owner)} versenkt.`, `You sank a warship of ${name(e.owner)}.`), 'good');
        else if (e.owner === me.id) hud.post(t(`${name(e.by)} hat dein Kriegsschiff versenkt!`, `${name(e.by)} sank your warship!`), 'bad');
        this.renderer.shellHit(e.tile);
      } else if (e.type === 'shelled') {
        this.renderer.shellHit(e.tile);
        if (e.by === me.id || e.owner === me.id) sound.play('boom', 0.35);
        // Once in a while, not for every shell.
        if (e.owner === me.id && performance.now() - this.lastShellNote > 15000) {
          this.lastShellNote = performance.now();
          hud.post(t(`Ein Kriegsschiff von ${name(e.by)} beschießt deine Küste!`, `A warship of ${name(e.by)} is shelling your coast!`), 'bad');
        }
      } else if (e.type === 'donated') {
        const what = [e.troops > 0 ? t(`${formatTroops(e.troops)} Truppen`, `${formatTroops(e.troops)} troops`) : '', e.gold > 0 ? t(`${formatTroops(e.gold)} Gold`, `${formatTroops(e.gold)} gold`) : ''].filter(Boolean).join(t(' und ', ' and '));
        if (e.to === me.id) hud.post(t(`${name(e.from)} schickt dir ${what}.`, `${name(e.from)} sends you ${what}.`), 'good');
        else if (e.from === me.id) hud.toast(t(`Du hast ${name(e.to)} ${what} geschickt.`, `You sent ${name(e.to)} ${what}.`));
      } else if (e.type === 'flooded') {
        this.renderer.flood(e.tiles);
        if (!this.floodAnnounced) {
          this.floodAnnounced = true;
          hud.post(t('Das Meer steigt! Rot markiertes Land geht in 20 Sekunden unter.', 'The sea is rising! Land marked red goes under within 20 seconds.'), 'bad');
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
      [t('Platz', 'Place'), `${place}/${this.game.players.length}`],
      [t('Meistes Land', 'Most land'), formatShare(me.peakTiles / this.game.map.landTiles)],
      [t('Zeit', 'Time'), this.matchTime()],
    ];
  }

  /** The land-over-time chart for the results screen, once there is enough history. */
  private chart(): HTMLElement | null {
    const data = chartData(this.game, this.history, this.me?.id ?? null);
    return data ? landChart(data) : null;
  }

  /** What kind of match this was, for a shared result: the daily challenge's title, or the mode. */
  private matchLabel(): string {
    const s = this.game.settings;
    const mode = s.royale
      ? 'Battle Royale'
      : s.conquest
        ? t('Totale Eroberung', 'Total conquest')
        : s.timeLimit > 0
          ? t('Schnelles Spiel', 'Quick match')
          : t('Klassisch', 'Classic');
    return this.options.play?.title ?? mode;
  }

  /** The share button for a results card: a line about the match, plus the link. */
  private shareAction(won: boolean): { label: string; run(): void } {
    const label = this.matchLabel();
    const time = this.matchTime();
    const me = this.me!;
    const place = me.place || this.game.players.filter((p) => p.alive && p.tiles > me.tiles).length + 1;
    const total = this.game.players.length;
    const text = won
      ? this.game.teamGame
        ? t(`🏆 Mein Team hat bei Landgrab gewonnen: ${label} in ${time}. Schafft ihr das schneller?`, `🏆 My team won at Landgrab: ${label} in ${time}. Can you beat that?`)
        : t(`🏆 Ich habe bei Landgrab gewonnen: ${label} in ${time}. Schaffst du das schneller?`, `🏆 I won at Landgrab: ${label} in ${time}. Can you do it faster?`)
      : t(`⚔️ Landgrab: Platz ${place} von ${total} (${label}). Schlag mich!`, `⚔️ Landgrab: place ${place} of ${total} (${label}). Beat me!`);
    const shareLabel = t('Teilen', 'Share');
    return {
      label: shareLabel,
      run: () => {
        void share(text).then((result) => {
          // The results card covers the toast, so the button itself says what happened.
          const note = shareNote(result);
          const button = [...document.querySelectorAll<HTMLButtonElement>('#overlay button')].find((b) => b.textContent === shareLabel);
          if (!note || !button) return;
          button.textContent = result === 'copied' ? t('Kopiert ✓', 'Copied ✓') : note;
          window.setTimeout(() => (button.textContent = shareLabel), 2500);
        });
      },
    };
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
      eyebrow: t('Niederlage', 'Defeat'),
      title: t('Ausgeschieden', 'Eliminated'),
      text: t(`${this.game.player(by).name} hat nach ${this.matchTime()} dein letztes Feld erobert.`, `${this.game.player(by).name} took your last tile after ${this.matchTime()}.`),
      stats: this.stats(),
      extra: this.chart(),
      actions: [
        { label: t('Nochmal spielen', 'Play again'), primary: true, run: () => play.hooks.playAgain() },
        this.shareAction(false),
        { label: t('Weiter zuschauen', 'Keep watching'), run: () => play.hud.hideOverlay() },
        { label: t('Wiederholung', 'Replay'), run: () => play.hooks.replay(this.game.log.slice()) },
        { label: t('Menü', 'Menu'), run: () => play.hooks.menu() },
      ],
    });
    play.hud.setBanner(t('Du schaust zu. Die Bots spielen weiter.', 'You\'re watching. The bots play on.'));
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
      eyebrow = won ? t('Sieg', 'Victory') : me.alive ? t('Niederlage', 'Defeat') : t('Partie vorbei', 'Match over');
      title = won ? t('Dein Team gewinnt', 'Your team wins') : t(`Team ${winner.name} gewinnt`, `Team ${winner.name} wins`);
      const holder = won ? t('Deinem Team', 'Your team') : `Team ${winner.name}`;
      text = this.game.settings.conquest
        ? t(`${holder} hat nach ${this.matchTime()} alle anderen Teams besiegt.`, `${holder} wiped out every other team in ${this.matchTime()}.`)
        : timed
          ? t(`Die Zeit ist um. ${holder} gehören ${teamShare} des Landes.`, `Time's up. ${holder} holds ${teamShare} of the land.`)
          : t(`${holder} gehören nach ${this.matchTime()} ${teamShare} des Landes.`, `${holder} holds ${teamShare} of the land after ${this.matchTime()}.`);
    } else if (winnerId === me.id) {
      eyebrow = t('Sieg', 'Victory');
      title = lastStanding ? t('Als Letzter übrig', 'Last one standing') : timed ? t('Das meiste Land zum Schluss', 'Most land at the end') : t('Die Karte gehört dir', 'The map is yours');
      text = timed ? t(`Die Zeit ist um. Dir gehören ${share} des Landes.`, `Time\'s up. You hold ${share} of the land.`) : t(`Nach ${this.matchTime()} gehören dir ${share} des Landes.`, `After ${this.matchTime()} you hold ${share} of the land.`);
    } else {
      eyebrow = me.alive ? t('Niederlage', 'Defeat') : t('Partie vorbei', 'Match over');
      title = t(`${winner.name} gewinnt`, `${winner.name} wins`);
      text = timed
        ? t(`Die Zeit ist um. ${winner.name} gehören ${share} des Landes.`, `Time\'s up. ${winner.name} holds ${share} of the land.`)
        : t(`${winner.name} hat nach ${this.matchTime()} ${share} des Landes erobert.`, `${winner.name} conquered ${share} of the land in ${this.matchTime()}.`);
    }
    const won = winnerId === me.id || (this.game.teamGame && winner.team === me.team);
    if (this.replay) eyebrow = t('Ende der Wiederholung', 'End of the replay');
    else if (!this.resultReported) {
      this.resultReported = true;
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
        { label: t('Nochmal spielen', 'Play again'), primary: true, run: () => play.hooks.playAgain() },
        ...(this.replay ? [] : [this.shareAction(won)]),
        { label: this.replay ? t('Nochmal ansehen', 'Watch again') : t('Wiederholung', 'Replay'), run: () => play.hooks.replay((this.replay ?? this.game.log).slice()) },
        { label: t('Menü', 'Menu'), run: () => play.hooks.menu() },
      ],
    });
  }
}
