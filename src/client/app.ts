import type { Difficulty } from '../core/bots';
import { Game, type GameSettings } from '../core/game';
import type { GameMap, MapSize } from '../core/map';
import type { RealMapId } from '../core/realmaps';
import { createMap, createSettings, mapSizeFor, type MatchOptions, type Mode } from '../core/setup';
import { fromHex, SWATCHES, toHex } from './colors';
import { byId, Hud } from './hud';
import { loadPrefs, savePrefs, type Prefs } from './prefs';
import { Session, type IntentLog } from './session';
import { Tutorial } from './tutorial';
import { t, translatePage } from './i18n';
import { ACHIEVEMENTS, loadProfile, recordMatch, unlock } from './achievements';
import { SettingsPanel } from './settings';
import { formatClock } from './format';
import { progress, recordResult, today, type Daily } from './daily';

function randomSeed(): number {
  return 10000 + Math.floor(Math.random() * 90000);
}

/** Switches between the menu (with a live preview of the next map) and a match. */
export class App {
  private readonly canvas = byId<HTMLCanvasElement>('view');
  private readonly menu = byId('menu');
  private readonly menuCard = this.menu.querySelector<HTMLElement>('.menu-card')!;
  private readonly form = byId<HTMLFormElement>('menu-form');
  private readonly nameInput = byId<HTMLInputElement>('name');
  private readonly botsInput = byId<HTMLInputElement>('bots');
  private readonly botsOut = byId<HTMLOutputElement>('bots-out');
  private readonly fogInput = byId<HTMLInputElement>('fog');
  private readonly sizeField = byId<HTMLFieldSetElement>('size-field');
  private readonly swatches = byId('swatches');
  private readonly dailyDesc = byId('daily-desc');
  private readonly dailyBest = byId('daily-best');
  private readonly moreSummary = byId('more-summary');
  private readonly hud = new Hud();
  private session: Session | null = null;
  private seed = randomSeed();
  private map: GameMap | null = null;
  private mapKey = '';
  private color: number;

  constructor() {
    translatePage();
    new SettingsPanel();
    const prefs = loadPrefs();
    this.color = prefs.color;
    this.initMenu(prefs);
    this.showMenu();
  }

  private initMenu(prefs: Prefs): void {
    this.nameInput.value = prefs.name;
    this.botsInput.value = String(prefs.bots);
    this.botsOut.textContent = String(prefs.bots);
    this.fogInput.checked = prefs.fog;
    this.check(`mode-${prefs.mode}`);
    this.check(`size-${prefs.mapSize}`);
    this.check(`diff-${prefs.difficulty}`);
    this.check(`teams-${prefs.teams}`);
    this.check(`world-${prefs.world ?? 'none'}`);
    this.sizeField.disabled = prefs.mode === 'quick';
    this.buildSwatches();

    this.summarise();
    this.botsInput.addEventListener('input', () => {
      this.botsOut.textContent = this.botsInput.value;
      this.summarise();
    });
    this.form.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.name === 'mode') this.sizeField.disabled = target.value === 'quick';
      if (target.name === 'mode' || target.name === 'size' || target.name === 'world') this.preview();
      this.summarise();
    });
    byId('daily-play').addEventListener('click', () => this.playDaily());
    byId('tutorial-play').addEventListener('click', () => this.playTutorial());
    byId('profile-open').addEventListener('click', () => this.showProfile());
    byId('profile-close').addEventListener('click', () => (byId('profile').hidden = true));
    byId('profile').addEventListener('pointerdown', (e) => {
      if (e.target === e.currentTarget) byId('profile').hidden = true;
    });
    byId('profile').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') byId('profile').hidden = true;
    });
    byId('reroll').addEventListener('click', () => {
      this.seed = randomSeed();
      this.preview();
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.play();
    });
    window.addEventListener('resize', () => {
      if (!this.menu.hidden) this.session?.refit();
    });
  }

  /** One line under "Mehr Optionen" saying what is set, so the folded options aren't a mystery. */
  private summarise(): void {
    const maps: Record<string, string> = { '': t('Zufallskarte', 'Random map'), world: t('Weltkarte', 'World map'), europe: t('Europa', 'Europe'), germany: t('Deutschland', 'Germany') };
    const sizes: Record<string, string> = { small: t('Klein', 'Small'), medium: t('Mittel', 'Medium'), large: t('Groß', 'Large'), huge: t('Riesig', 'Huge') };
    const levels: Record<string, string> = { easy: t('Leicht', 'Easy'), normal: 'Normal', hard: t('Schwer', 'Hard') };
    const quick = this.radio('mode') === 'quick';
    const teams = Number(this.radio('teams'));
    const parts = [
      maps[this.radio('world')] ?? t('Zufallskarte', 'Random map'),
      quick ? t('Klein', 'Small') : sizes[this.radio('size')],
      `${this.botsInput.value} ${t('Bots', 'bots')}, ${levels[this.radio('difficulty')]}`,
    ];
    if (teams) parts.push(t(`${teams} Teams`, `${teams} teams`));
    if (this.fogInput.checked) parts.push(t('Nebel', 'Fog'));
    this.moreSummary.textContent = parts.join(' · ');
  }

  private check(id: string): void {
    byId<HTMLInputElement>(id).checked = true;
  }

  private buildSwatches(): void {
    const items = SWATCHES.map((s, i) => {
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'color';
      input.id = `color-${i}`;
      input.value = toHex(s.color);
      input.checked = s.color === this.color;
      input.addEventListener('change', () => (this.color = s.color));
      const label = document.createElement('label');
      label.htmlFor = input.id;
      label.className = 'swatch';
      label.title = s.name;
      label.style.setProperty('--c', toHex(s.color));
      const text = document.createElement('span');
      text.className = 'sr-only';
      text.textContent = s.name;
      label.append(text);
      return [input, label];
    });

    // Any other colour, through the browser's picker.
    const custom = document.createElement('label');
    custom.className = 'swatch custom';
    custom.title = t('Eigene Farbe wählen', 'Pick your own colour');
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.id = 'color-custom';
    picker.setAttribute('aria-label', t('Eigene Farbe wählen', 'Pick your own colour'));
    const preset = SWATCHES.some((s) => s.color === this.color);
    picker.value = toHex(preset ? 0x888888 : this.color);
    custom.classList.toggle('selected', !preset);
    custom.style.setProperty('--c', picker.value);
    picker.addEventListener('input', () => {
      this.color = fromHex(picker.value);
      custom.style.setProperty('--c', picker.value);
      custom.classList.add('selected');
      this.swatches.querySelectorAll<HTMLInputElement>('input[name=color]').forEach((r) => (r.checked = false));
    });
    this.swatches.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).name === 'color') custom.classList.remove('selected');
    });
    custom.append(picker);
    this.swatches.replaceChildren(...items.flat(), custom);
  }

  private radio(name: string): string {
    return this.form.querySelector<HTMLInputElement>(`input[name=${name}]:checked`)?.value ?? '';
  }

  private options(): MatchOptions {
    const name = this.nameInput.value.trim().slice(0, 16) || t('Du', 'You');
    return {
      seed: this.seed,
      mode: this.radio('mode') as Mode,
      mapSize: this.radio('size') as MapSize,
      bots: Number(this.botsInput.value),
      difficulty: this.radio('difficulty') as Difficulty,
      teams: Number(this.radio('teams')) || 0,
      world: (this.radio('world') || null) as RealMapId | null,
      human: { name, color: this.color },
    };
  }

  /** The map for these options, generated once per seed and size. */
  private mapFor(options: MatchOptions): GameMap {
    const key = `${options.seed}:${mapSizeFor(options)}:${options.world ?? ''}`;
    if (!this.map || key !== this.mapKey) {
      this.map = createMap(options);
      this.mapKey = key;
    }
    return this.map;
  }

  private menuInset() {
    if (window.innerWidth < 760) return { left: 0, top: 0, right: 0, bottom: 0 };
    return { left: this.menuCard.getBoundingClientRect().right + 24, top: 24, right: 24, bottom: 24 };
  }

  private preview(): void {
    const options = this.options();
    const game = new Game(createSettings(options, this.mapFor(options)));
    this.session?.dispose();
    this.session = new Session(this.canvas, game, { inset: () => this.menuInset() });
  }

  private showMenu(): void {
    this.hud.hide();
    this.menu.hidden = false;
    this.showDaily();
    this.preview();
  }

  /** Lifetime numbers and every achievement, unlocked ones in colour. */
  private showProfile(): void {
    const profile = loadProfile();
    const unlocked = ACHIEVEMENTS.filter((a) => profile.unlocked[a.id]).length;
    const stats: [string, string][] = [
      [t('Partien', 'Matches'), String(profile.played)],
      [t('Siege', 'Wins'), String(profile.won)],
      [t('Erfolge', 'Achievements'), `${unlocked}/${ACHIEVEMENTS.length}`],
    ];
    byId('profile-stats').replaceChildren(
      ...stats.map(([label, value]) => {
        const div = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        div.append(dt, dd);
        return div;
      }),
    );
    byId('profile-list').replaceChildren(
      ...ACHIEVEMENTS.map((a) => {
        const li = document.createElement('li');
        const done = profile.unlocked[a.id];
        li.className = done ? 'done' : '';
        const name = document.createElement('strong');
        name.textContent = `${done ? '🏆' : '🔒'} ${a.name}`;
        const text = document.createElement('span');
        text.textContent = a.text;
        li.append(name, text);
        return li;
      }),
    );
    byId('profile').hidden = false;
    byId('profile-close').focus();
  }

  private showDaily(): void {
    // Newcomers: the tutorial button stands out until it's done once.
    byId('tutorial-play').classList.toggle('suggest', !loadProfile().unlocked.tutorial);
    const daily = today();
    const { best, tries } = progress(daily);
    this.dailyDesc.textContent = daily.title;
    this.dailyBest.textContent = best
      ? t(`Deine Bestzeit heute: ${formatClock(best)}`, `Your best time today: ${formatClock(best)}`)
      : tries
        ? t(`Noch nicht geschafft (${tries} ${tries === 1 ? 'Versuch' : 'Versuche'}). Gewinne so schnell du kannst.`, `Not won yet (${tries} ${tries === 1 ? 'try' : 'tries'}). Win as fast as you can.`)
        : t('Gewinne so schnell du kannst. Alle spielen heute dieselbe Karte.', 'Win as fast as you can. Everyone plays the same map today.');
  }

  /** The guided first match: a small island, three easy bots, gold for a city. */
  private playTutorial(): void {
    const options: MatchOptions = { seed: 31337, mode: 'classic', mapSize: 'small', bots: 3, difficulty: 'easy', teams: 0, human: this.options().human };
    this.start({ ...createSettings(options, this.mapFor(options)), startGold: 3000 }, { fog: false, tutorial: true });
  }

  /** Today's challenge, with the name and colour from the menu. */
  private playDaily(): void {
    const daily = today();
    const options: MatchOptions = { ...daily.options, human: this.options().human };
    this.start(createSettings(options, this.mapFor(options)), { fog: daily.fog, daily });
  }

  private play(): void {
    const options = this.options();
    savePrefs({
      name: this.nameInput.value.trim().slice(0, 16),
      color: this.color,
      mode: options.mode,
      mapSize: options.mapSize,
      bots: options.bots,
      difficulty: options.difficulty,
      fog: this.fogInput.checked,
      teams: options.teams ?? 0,
      world: options.world ?? null,
    });
    this.start(createSettings(options, this.mapFor(options)), { fog: this.fogInput.checked, realMap: !!options.world });
  }

  /** Runs a match with these settings: a fresh one, or a replay when given the intent log. */
  private start(settings: GameSettings, how: { fog: boolean; replay?: IntentLog; daily?: Daily; tutorial?: boolean; realMap?: boolean }): void {
    const { replay, daily } = how;
    const tutorial = how.tutorial && !replay ? new Tutorial() : undefined;
    if (tutorial) tutorial.onFinish = (completed) => completed && unlock('tutorial');
    // Fog of war is part of the rules: bots then see only what a human would.
    const game = new Game({ ...settings, fog: how.fog });
    this.menu.hidden = true;
    this.session?.dispose();
    this.session = new Session(this.canvas, game, {
      play: {
        hud: this.hud,
        replay,
        fog: how.fog,
        tutorial,
        title: daily ? `${t('Tägliche Herausforderung', 'Daily challenge')} ${daily.date}` : undefined,
        hooks: {
          playAgain: () => {
            if (daily) {
              this.playDaily();
              return;
            }
            this.seed = randomSeed();
            this.play();
          },
          menu: () => {
            this.seed = randomSeed();
            this.showMenu();
          },
          replay: (log) => this.start(settings, { ...how, replay: log }),
          result: (won, seconds) => {
            recordMatch({
              won,
              mode: settings.royale ? 'royale' : settings.conquest ? 'conquest' : settings.timeLimit > 0 ? 'quick' : 'classic',
              teams: settings.players.some((p) => (p.team ?? 0) !== 0),
              realMap: how.realMap ?? false,
              hard: settings.difficulty === 'hard',
              fog: how.fog,
              daily: !!daily,
            });
            if (!daily) return null;
            const best = recordResult(daily, won, seconds);
            if (best) return t(`Neue Tagesbestzeit: ${formatClock(seconds)}!`, `New best time today: ${formatClock(seconds)}!`);
            const { best: time } = progress(daily);
            return time ? t(`Deine Tagesbestzeit: ${formatClock(time)}.`, `Your best time today: ${formatClock(time)}.`) : null;
          },
        },
      },
    });
    this.canvas.focus({ preventScroll: true });
  }
}
