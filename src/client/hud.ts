import { CONFIG } from '../core/config';
import { NEUTRAL, type Game, type Player } from '../core/game';
import { toHex } from './colors';
import { uiScale } from './settings';
import { sound } from './sound';
import { formatClock, formatCount, formatShare, formatTroops } from './format';
import { GROUP_NAMES, iconSvg, isMissile, TOOLS, type ToolKind } from './tools';

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

export type Tone = 'good' | 'bad' | 'info' | 'tip';

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
  /** Extra content under the stats, such as the land chart. */
  extra?: HTMLElement | null;
}

const BOARD_ROWS = 8;
const MISSILE_NAMES = { rocket: 'Rakete', nuke: 'Atombombe', hbomb: 'H-Bombe' } as const;
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
  /** Called when one of your attacks is clicked, to call it off. */
  onRecall: (target: number) => void = () => {};
  readonly minimap = byId<HTMLCanvasElement>('minimap');
  private readonly tip = byId('tip');
  private readonly meChip = byId('me-chip');
  private readonly meName = byId('me-name');
  private readonly clock = byId('clock');
  private readonly banner = byId('banner');
  private readonly board = byId<HTMLOListElement>('board');
  private readonly teamTotals = byId<HTMLUListElement>('team-totals');
  /** In fog of war: players whose numbers are hidden right now. */
  unseen: (id: number) => boolean = () => false;
  private readonly fronts = byId<HTMLUListElement>('fronts');
  private readonly feed = byId<HTMLUListElement>('feed');
  private readonly toastEl = byId('toast');
  private readonly overlay = byId('overlay');
  private readonly overlayEyebrow = byId('overlay-eyebrow');
  private readonly overlayTitle = byId('overlay-title');
  private readonly overlayText = byId('overlay-text');
  private readonly overlayStats = byId('overlay-stats');
  private readonly overlayActions = byId('overlay-actions');
  private readonly overlayExtra = byId('overlay-extra');
  readonly pauseButton = byId<HTMLButtonElement>('pause-button');
  readonly centerButton = byId<HTMLButtonElement>('center-button');
  readonly speedButton = byId<HTMLButtonElement>('speed-button');
  private toastTimer = 0;
  private readonly offerEl = byId('offer');
  private readonly offerText = byId('offer-text');
  /** Player whose alliance offer is on screen, or 0. */
  offerFrom = 0;
  /** Called with true (accept) or false (decline) when the offer card is answered. */
  onOffer: (from: number, accept: boolean) => void = () => {};

  constructor() {
    byId('offer-accept').addEventListener('click', () => this.answerOffer(true));
    byId('offer-decline').addEventListener('click', () => this.answerOffer(false));
    // The chips are rebuilt several times a second, so act on press, not click.
    this.fronts.addEventListener('pointerdown', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-target]');
      if (li) this.onRecall(Number(li.dataset.target));
    });
    const bar = byId('tools');
    TOOLS.forEach((tool, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      // A gap and a hairline where a new group starts.
      button.className = i > 0 && TOOLS[i - 1].group !== tool.group ? 'tool group-start' : 'tool';
      button.title = `${tool.name} (${tool.key.toUpperCase()}) · ${GROUP_NAMES[tool.group]}\n${tool.hint}`;
      button.innerHTML = `${iconSvg(tool.kind)}<span class="tool-name"></span><span class="tool-cost"></span><kbd></kbd>`;
      button.querySelector('.tool-name')!.textContent = tool.name;
      button.querySelector('kbd')!.textContent = tool.key;
      button.addEventListener('click', () => this.onTool(tool.kind));
      this.toolButtons.set(tool.kind, button);
      bar.append(button);
    });
  }

  show(me: Player): void {
    this.root.hidden = false;
    this.meChip.style.setProperty('--c', toHex(me.color));
    this.meName.textContent = me.name;
    this.feed.replaceChildren();
    this.fronts.replaceChildren();
    this.hideOffer();
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
      this.growth.textContent = 'Voll: schick Truppen los';
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
    } else if (game.settings.royale && game.floodStartsIn() > 0) {
      const left = game.floodStartsIn() / CONFIG.ticksPerSecond;
      this.clock.textContent = `🌊 ${formatClock(Math.ceil(left))}`;
      this.clock.classList.toggle('urgent', left <= 10);
    } else {
      this.clock.textContent = game.settings.royale ? `🌊 ${formatClock(seconds)}` : formatClock(seconds);
      this.clock.classList.remove('urgent');
    }

    this.updateBoard(game, me);
    this.updateFronts(game, me);
  }

  /** Prices, and which tools are usable right now. */
  updateTools(game: Game, me: Player, active: ToolKind | null): void {
    for (const [kind, button] of this.toolButtons) {
      let ready = me.alive && game.phase === 'play';
      if (kind === 'ally') {
        button.querySelector('.tool-cost')!.textContent = '3 Min';
      } else if (kind === 'warship') {
        const afloat = game.warships.some((s) => s.owner === me.id);
        const refusal = game.canWarship(me);
        ready &&= refusal === null || afloat;
        button.querySelector('.tool-cost')!.textContent = refusal === 'limit' ? 'lenken' : formatTroops(CONFIG.warship.cost);
      } else {
        const missile = isMissile(kind);
        const cost = missile ? game.missileCost(kind) : game.buildCost(me, kind);
        const full = !missile && me.owned[kind] >= game.buildLimit(me, kind);
        ready &&= !full && me.gold >= cost && (!missile || game.readySilos(me) > 0);
        button.querySelector('.tool-cost')!.textContent = full ? 'voll' : formatTroops(cost);
      }
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
      const ends = game.allianceEnds(me.id, p.id);
      if (game.teammates(me.id, p.id)) {
        name.textContent = `👥 ${p.name}`;
        li.classList.add('ally');
      } else {
        name.textContent = ends ? `🤝 ${p.name} · ${formatClock((ends - game.tick) / CONFIG.ticksPerSecond)}` : p.name;
        if (ends) li.classList.add('ally');
      }
      const share = document.createElement('span');
      share.className = 'share';
      share.textContent = this.unseen(p.id) ? '?' : formatShare(p.tiles / game.map.landTiles);
      li.append(r, dot, name, share);
      return li;
    };
    ranked.slice(0, BOARD_ROWS).forEach((p, i) => rows.push(row(p, i + 1)));
    const myRank = ranked.indexOf(me);
    if (myRank >= BOARD_ROWS) rows.push(row(me, myRank + 1));
    this.board.replaceChildren(...rows);
    this.updateTeams(game, me);
  }

  /** In team games, each team's share of the land, yours first. */
  private updateTeams(game: Game, me: Player): void {
    this.teamTotals.hidden = !game.teamGame;
    if (!game.teamGame) return;
    const totals = game.teamTiles();
    const items: HTMLLIElement[] = [];
    totals.forEach((tiles, team) => {
      if (tiles === undefined) return;
      const lead = game.players.filter((p) => p.team === team && p.alive).sort((a, b) => b.tiles - a.tiles)[0];
      if (!lead) return;
      const li = document.createElement('li');
      if (team === me.team) li.className = 'me';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--c', toHex(lead.color));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = team === me.team ? 'Dein Team' : `Team ${lead.name}`;
      const share = document.createElement('span');
      share.className = 'share';
      share.textContent = formatShare(tiles / game.map.landTiles);
      li.append(dot, name, share);
      items.push(li);
    });
    items.sort((a, b) => Number(b.classList.contains('me')) - Number(a.classList.contains('me')));
    this.teamTotals.replaceChildren(...items);
  }

  private updateFronts(game: Game, me: Player): void {
    const items: HTMLLIElement[] = [];
    for (const b of game.boats) {
      if (b.owner !== me.id) continue;
      const li = document.createElement('li');
      li.className = 'outgoing';
      li.textContent = `⛵ Boot · ${formatTroops(b.troops)}`;
      items.push(li);
    }
    for (const m of game.missiles) {
      if (m.victim !== me.id || m.owner === me.id) continue;
      const li = document.createElement('li');
      li.className = 'incoming';
      const seconds = Math.max(0, Math.ceil((m.arrives - game.tick) / CONFIG.ticksPerSecond));
      li.textContent = `${MISSILE_NAMES[m.kind]} von ${game.player(m.owner).name} · ${seconds} s`;
      items.push(li);
    }
    for (const a of game.attacks) {
      if (a.attacker !== me.id && a.target !== me.id) continue;
      const li = document.createElement('li');
      const outgoing = a.attacker === me.id;
      li.className = outgoing ? 'outgoing' : 'incoming';
      const who = outgoing ? (a.target === NEUTRAL ? 'Freies Land' : game.player(a.target).name) : game.player(a.attacker).name;
      const pace = a.target !== NEUTRAL ? ` · ⚡${game.pressure(a).toFixed(1).replace('.', ',')}×` : '';
      li.textContent = `${outgoing ? '→' : '←'} ${who} · ${formatTroops(a.troops)}${pace}${outgoing ? ' ✕' : ''}`;
      li.title = outgoing ? `Deine Truppen rücken vor: ${who}. Klicken ruft sie zurück.` : `${who} greift dich an`;
      if (outgoing) li.dataset.target = String(a.target);
      items.push(li);
    }
    // Keep the same elements when only the numbers changed, so a press on a chip always lands.
    const old = [...this.fronts.children] as HTMLElement[];
    const same =
      old.length === items.length &&
      items.every((li, i) => old[i].className === li.className && old[i].dataset.target === li.dataset.target);
    if (same) {
      items.forEach((li, i) => {
        old[i].textContent = li.textContent;
        old[i].title = li.title;
      });
    } else {
      this.fronts.replaceChildren(...items);
    }
  }

  /** A small card next to the cursor (CSS pixels), or null to hide it. */
  showTip(lines: string[] | null, x = 0, y = 0): void {
    if (!lines) {
      this.tip.hidden = true;
      return;
    }
    this.tip.replaceChildren(
      ...lines.map((text, i) => {
        const div = document.createElement('div');
        div.textContent = text;
        if (i === 0) div.className = 'tip-title';
        return div;
      }),
    );
    this.tip.hidden = false;
    const w = this.tip.offsetWidth * uiScale();
    const flip = x + 18 + w > window.innerWidth - 8;
    this.tip.style.left = `${flip ? x - 14 - w : x + 18}px`;
    this.tip.style.top = `${y + 14}px`;
  }

  post(text: string, tone: Tone): void {
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (tone === 'good' || tone === 'bad') sound.play(tone);
    const li = document.createElement('li');
    li.className = tone;
    const span = document.createElement('span');
    span.textContent = text;
    li.append(span);
    this.feed.prepend(li);
    while (this.feed.children.length > FEED_LIMIT) this.feed.lastElementChild?.remove();
    // Tips stay up long enough to read.
    const ms = tone === 'tip' ? FEED_MS * 2 : FEED_MS;
    window.setTimeout(() => li.classList.add('fading'), ms);
    window.setTimeout(() => li.remove(), ms + 700);
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
    this.overlayExtra.replaceChildren(...(content.extra ? [content.extra] : []));
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

  /** A card under the clock: another player offers you an alliance. */
  showOffer(from: Player, seconds: number): void {
    this.offerFrom = from.id;
    this.offerText.replaceChildren();
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--c', toHex(from.color));
    const name = document.createElement('strong');
    name.textContent = from.name;
    this.offerText.append(chip, name, ` bietet dir ein Bündnis an (${seconds} s)`);
    this.offerEl.hidden = false;
  }

  hideOffer(): void {
    this.offerFrom = 0;
    this.offerEl.hidden = true;
  }

  private answerOffer(accept: boolean): void {
    const from = this.offerFrom;
    this.hideOffer();
    if (from) this.onOffer(from, accept);
  }

  hideOverlay(): void {
    this.overlay.hidden = true;
  }

  /** Shows the game speed on its button; anything above 1× stands out. */
  set speed(value: number) {
    this.speedButton.textContent = `${value}×`;
    this.speedButton.setAttribute('aria-label', `Spieltempo: ${value}-fach`);
    this.speedButton.classList.toggle('fast', value > 1);
  }

  get overlayOpen(): boolean {
    return !this.overlay.hidden;
  }
}
