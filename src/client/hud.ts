import { CONFIG } from '../core/config';
import { NEUTRAL, type Game, type Player } from '../core/game';
import { toHex } from './colors';
import { formatClock, formatCount, formatShare, formatTroops } from './format';
import { iconSvg, isMissile, TOOLS, type ToolKind } from './tools';

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

export type Tone = 'good' | 'bad' | 'info';

export interface OverlayAction {
  label: string;
  primary?: boolean;
  run(): void;
}

export interface OverlayContent {
  eyebrow: string;
  title: string;
  text: string;
  stats: [string, string][];
  actions: OverlayAction[];
}

const BOARD_ROWS = 8;
const FEED_LIMIT = 4;
const FEED_MS = 7000;

/** The DOM around the map: stats, leaderboard, send slider, messages and dialogs. */
export class Hud {
  readonly root = byId('hud');
  readonly ratio = byId<HTMLInputElement>('ratio');
  private readonly ratioOut = byId<HTMLOutputElement>('ratio-out');
  private readonly troops = byId('troops');
  private readonly troopsMax = byId('troops-max');
  private readonly growth = byId('growth');
  private readonly land = byId('land');
  private readonly tiles = byId('tiles');
  private readonly gold = byId('gold');
  private readonly goldRate = byId('gold-rate');
  private readonly toolButtons = new Map<ToolKind, HTMLButtonElement>();
  /** Called when a build bar button is pressed. */
  onTool: (kind: ToolKind) => void = () => {};
  private readonly meChip = byId('me-chip');
  private readonly meName = byId('me-name');
  private readonly clock = byId('clock');
  private readonly banner = byId('banner');
  private readonly board = byId<HTMLOListElement>('board');
  private readonly fronts = byId<HTMLUListElement>('fronts');
  private readonly feed = byId<HTMLUListElement>('feed');
  private readonly toastEl = byId('toast');
  private readonly overlay = byId('overlay');
  private readonly overlayEyebrow = byId('overlay-eyebrow');
  private readonly overlayTitle = byId('overlay-title');
  private readonly overlayText = byId('overlay-text');
  private readonly overlayStats = byId('overlay-stats');
  private readonly overlayActions = byId('overlay-actions');
  readonly pauseButton = byId<HTMLButtonElement>('pause-button');
  readonly centerButton = byId<HTMLButtonElement>('center-button');
  private toastTimer = 0;

  constructor() {
    const bar = byId('tools');
    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool';
      button.title = `${tool.name} (${tool.key.toUpperCase()}): ${tool.hint}`;
      button.innerHTML = `${iconSvg(tool.kind)}<span class="tool-name"></span><span class="tool-cost"></span><kbd></kbd>`;
      button.querySelector('.tool-name')!.textContent = tool.name;
      button.querySelector('kbd')!.textContent = tool.key;
      button.addEventListener('click', () => this.onTool(tool.kind));
      this.toolButtons.set(tool.kind, button);
      bar.append(button);
    }
  }

  show(me: Player): void {
    this.root.hidden = false;
    this.meChip.style.setProperty('--c', toHex(me.color));
    this.meName.textContent = me.name;
    this.feed.replaceChildren();
    this.fronts.replaceChildren();
    this.hideOverlay();
  }

  hide(): void {
    this.root.hidden = true;
    this.hideOverlay();
  }

  get percent(): number {
    return Number(this.ratio.value);
  }

  set percent(value: number) {
    this.ratio.value = String(Math.min(100, Math.max(5, value)));
  }

  setBanner(text: string): void {
    this.banner.textContent = text;
  }

  update(game: Game, me: Player): void {
    const max = game.maxTroops(me);
    this.troops.textContent = formatTroops(me.troops);
    this.troopsMax.textContent = formatTroops(max);
    if (game.phase === 'spawn') {
      this.growth.textContent = '';
    } else if (!me.alive) {
      this.growth.textContent = 'Ausgeschieden';
    } else if (me.troops >= max) {
      this.growth.textContent = 'Obergrenze erreicht. Schick Truppen los, dann wächst du wieder.';
    } else {
      const perTick = me.troops * CONFIG.interest * (1 - me.troops / max) + me.tiles * CONFIG.landIncome;
      this.growth.textContent = `+${formatTroops(perTick * CONFIG.ticksPerSecond)} pro Sekunde`;
    }
    this.gold.textContent = formatTroops(me.gold);
    this.goldRate.textContent = me.alive && game.phase === 'play' ? `+${formatTroops(me.tiles * CONFIG.goldPerTile * CONFIG.ticksPerSecond)} pro Sekunde` : '';
    this.land.textContent = formatShare(me.tiles / game.map.landTiles);
    this.tiles.textContent = `${formatCount(me.tiles)} Felder`;
    this.ratioOut.textContent = `${this.percent}% · ${formatTroops((me.troops * this.percent) / 100)}`;

    const limit = game.settings.timeLimit;
    const seconds = game.tick / CONFIG.ticksPerSecond;
    if (game.phase === 'spawn') {
      this.clock.textContent = '';
    } else if (limit > 0) {
      const left = (limit - game.tick) / CONFIG.ticksPerSecond;
      this.clock.textContent = formatClock(Math.ceil(left));
      this.clock.classList.toggle('urgent', left <= 30);
    } else {
      this.clock.textContent = formatClock(seconds);
    }

    this.updateBoard(game, me);
    this.updateFronts(game, me);
  }

  /** Prices, and which tools are usable right now. */
  updateTools(game: Game, me: Player, active: ToolKind | null): void {
    for (const [kind, button] of this.toolButtons) {
      const missile = isMissile(kind);
      const cost = missile ? game.missileCost(kind) : game.buildCost(me, kind);
      const ready = me.alive && game.phase === 'play' && me.gold >= cost && (!missile || me.owned.silo > 0);
      button.querySelector('.tool-cost')!.textContent = formatTroops(cost);
      button.classList.toggle('locked', !ready);
      button.classList.toggle('active', kind === active);
      button.setAttribute('aria-pressed', String(kind === active));
    }
  }

  private updateBoard(game: Game, me: Player): void {
    const ranked = game.players.filter((p) => p.alive && p.tiles > 0).sort((a, b) => b.tiles - a.tiles || a.id - b.id);
    const rows: HTMLLIElement[] = [];
    const row = (p: Player, rank: number) => {
      const li = document.createElement('li');
      if (p === me) li.className = 'me';
      const r = document.createElement('span');
      r.className = 'rank';
      r.textContent = String(rank);
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--c', toHex(p.color));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      const share = document.createElement('span');
      share.className = 'share';
      share.textContent = formatShare(p.tiles / game.map.landTiles);
      li.append(r, dot, name, share);
      return li;
    };
    ranked.slice(0, BOARD_ROWS).forEach((p, i) => rows.push(row(p, i + 1)));
    const myRank = ranked.indexOf(me);
    if (myRank >= BOARD_ROWS) rows.push(row(me, myRank + 1));
    this.board.replaceChildren(...rows);
  }

  private updateFronts(game: Game, me: Player): void {
    const items: HTMLLIElement[] = [];
    for (const m of game.missiles) {
      if (m.victim !== me.id || m.owner === me.id) continue;
      const li = document.createElement('li');
      li.className = 'incoming';
      const seconds = Math.max(0, Math.ceil((m.arrives - game.tick) / CONFIG.ticksPerSecond));
      li.textContent = `${m.kind === 'nuke' ? 'Atombombe' : 'Rakete'} von ${game.player(m.owner).name} · ${seconds} s`;
      items.push(li);
    }
    for (const a of game.attacks) {
      if (a.attacker !== me.id && a.target !== me.id) continue;
      const li = document.createElement('li');
      const outgoing = a.attacker === me.id;
      li.className = outgoing ? 'outgoing' : 'incoming';
      const who = outgoing ? (a.target === NEUTRAL ? 'Freies Land' : game.player(a.target).name) : game.player(a.attacker).name;
      li.textContent = `${outgoing ? '→' : '←'} ${who} · ${formatTroops(a.troops)}`;
      li.title = outgoing ? `Deine Truppen rücken vor: ${who}` : `${who} greift dich an`;
      items.push(li);
    }
    this.fronts.replaceChildren(...items);
  }

  post(text: string, tone: Tone): void {
    const li = document.createElement('li');
    li.className = tone;
    li.textContent = text;
    this.feed.prepend(li);
    while (this.feed.children.length > FEED_LIMIT) this.feed.lastElementChild?.remove();
    window.setTimeout(() => li.classList.add('fading'), FEED_MS);
    window.setTimeout(() => li.remove(), FEED_MS + 700);
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), 2200);
  }

  showOverlay(content: OverlayContent): void {
    this.overlayEyebrow.textContent = content.eyebrow;
    this.overlayTitle.textContent = content.title;
    this.overlayText.textContent = content.text;
    this.overlayStats.replaceChildren(
      ...content.stats.map(([label, value]) => {
        const div = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        div.append(dt, dd);
        return div;
      }),
    );
    this.overlayStats.hidden = content.stats.length === 0;
    const buttons = content.actions.map((action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `button ${action.primary ? 'primary' : 'ghost'}`;
      button.textContent = action.label;
      button.addEventListener('click', () => action.run());
      return button;
    });
    this.overlayActions.replaceChildren(...buttons);
    this.overlay.hidden = false;
    buttons.find((_, i) => content.actions[i].primary)?.focus();
  }

  hideOverlay(): void {
    this.overlay.hidden = true;
  }

  get overlayOpen(): boolean {
    return !this.overlay.hidden;
  }
}
