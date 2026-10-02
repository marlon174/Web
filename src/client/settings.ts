import { byId } from './hud';
import { sound } from './sound';
import { resetTips } from './tips';
import { lang, setLang, t } from './i18n';

/** Display choices, remembered in this browser. They never touch the simulation. */
export interface Settings {
  /** Size of every panel and button, as a factor of the default. */
  uiScale: number;
  /** Sound volume, 0 (off) to 1. */
  volume: number;
  showBoard: boolean;
  showFeed: boolean;
  showMinimap: boolean;
  showKeys: boolean;
  showTips: boolean;
}

const KEY = 'landgrab.settings.v1';
export const UI_SCALE_MIN = 0.6;
export const UI_SCALE_MAX = 1.4;

const DEFAULTS: Settings = {
  uiScale: 1,
  volume: 0.5,
  showBoard: true,
  showFeed: true,
  showMinimap: true,
  showKeys: true,
  showTips: true,
};

/** Checkbox id → setting, and the class on <html> that hides the panel when it's off. */
const TOGGLES: [string, 'showBoard' | 'showFeed' | 'showMinimap' | 'showKeys' | 'showTips', string][] = [
  ['set-board', 'showBoard', 'hide-board'],
  ['set-feed', 'showFeed', 'hide-feed'],
  ['set-minimap', 'showMinimap', 'hide-minimap'],
  ['set-keys', 'showKeys', 'hide-keys'],
  ['set-tips', 'showTips', 'hide-tips'],
];

function clampScale(value: number): number {
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(value * 20) / 20));
}

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const settings = { ...DEFAULTS };
    if (typeof saved.uiScale === 'number' && Number.isFinite(saved.uiScale)) settings.uiScale = clampScale(saved.uiScale);
    if (typeof saved.volume === 'number' && Number.isFinite(saved.volume)) settings.volume = Math.min(1, Math.max(0, saved.volume));
    for (const [, key] of TOGGLES) if (typeof saved[key] === 'boolean') settings[key] = saved[key];
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private windows and blocked storage: settings last until the page closes.
  }
}

/** The current UI scale, for code that positions things by hand (the tooltip). */
export function uiScale(): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui'));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Below this width (in unscaled CSS pixels) the corner panels leave no room for the banner between them. */
const CRAMPED_WIDTH = 1000;

function apply(settings: Settings): void {
  const root = document.documentElement;
  root.style.setProperty('--ui', String(settings.uiScale));
  sound.setVolume(settings.volume);
  root.classList.toggle('ui-cramped', window.innerWidth / settings.uiScale < CRAMPED_WIDTH);
  for (const [, key, hideClass] of TOGGLES) root.classList.toggle(hideClass, !settings[key]);
}

/** The settings dialog: opened from the menu and the in-game gear, applied live. */
export class SettingsPanel {
  private readonly root = byId('settings');
  private readonly scale = byId<HTMLInputElement>('ui-scale');
  private readonly scaleOut = byId<HTMLOutputElement>('ui-scale-out');
  private readonly volume = byId<HTMLInputElement>('volume');
  private readonly volumeOut = byId<HTMLOutputElement>('volume-out');
  private settings = loadSettings();
  private returnFocus: HTMLElement | null = null;

  constructor() {
    apply(this.settings);
    this.sync();
    window.addEventListener('resize', () => apply(this.settings));

    this.scale.addEventListener('input', () => this.update({ uiScale: Number(this.scale.value) / 100 }));
    this.volume.addEventListener('input', () => this.update({ volume: Number(this.volume.value) / 100 }));
    // A sample at the new level once the slider is let go.
    this.volume.addEventListener('change', () => sound.play('good'));
    for (const [id, key] of TOGGLES) {
      byId<HTMLInputElement>(id).addEventListener('change', (e) => this.update({ [key]: (e.target as HTMLInputElement).checked }));
    }
    for (const [id, value] of [['ui-small', 0.8], ['ui-normal', 1], ['ui-large', 1.2]] as const) {
      byId(id).addEventListener('click', () => this.update({ uiScale: value }));
    }
    byId('settings-reset').addEventListener('click', () => this.update(DEFAULTS));
    // Language: the page reloads in the new one.
    byId<HTMLInputElement>(`lang-${lang}`).checked = true;
    for (const next of ['de', 'en'] as const) {
      byId(`lang-${next}`).addEventListener('change', () => setLang(next));
    }
    byId('settings-done').addEventListener('click', () => this.close());
    // A click on the dimmed area around the card closes it.
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
    // Keys typed in here must not reach the game (Q–H tools, 1–0 send share).
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    for (const button of document.querySelectorAll<HTMLElement>('[data-open-settings]')) {
      button.addEventListener('click', () => this.open());
    }
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root.hidden = false;
    this.scale.focus({ preventScroll: true });
  }

  close(): void {
    this.root.hidden = true;
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  private update(change: Partial<Settings>): void {
    // Turning tips back on shows them all again.
    if (change.showTips && !this.settings.showTips) resetTips();
    this.settings = { ...this.settings, ...change };
    this.settings.uiScale = clampScale(this.settings.uiScale);
    apply(this.settings);
    saveSettings(this.settings);
    this.sync();
  }

  /** Puts the controls in line with the settings. */
  private sync(): void {
    const percent = Math.round(this.settings.uiScale * 100);
    this.scale.value = String(percent);
    this.scaleOut.textContent = `${percent} %`;
    const volume = Math.round(this.settings.volume * 100);
    this.volume.value = String(volume);
    this.volumeOut.textContent = volume === 0 ? t('Aus', 'Off') : `${volume} %`;
    for (const [id, key] of TOGGLES) byId<HTMLInputElement>(id).checked = this.settings[key];
    for (const [id, value] of [['ui-small', 0.8], ['ui-normal', 1], ['ui-large', 1.2]] as const) {
      byId(id).setAttribute('aria-pressed', String(Math.abs(this.settings.uiScale - value) < 0.01));
    }
  }
}
