import { CONFIG } from '../core/config';
import type { Game } from '../core/game';
import { toHex } from './colors';
import { formatClock, formatShare } from './format';

/** How often the land history takes a sample, in ticks (once a game second). */
const SAMPLE_EVERY = CONFIG.ticksPerSecond;
/** You plus this many of the strongest rivals; more lines would be a tangle. */
const RIVALS = 5;

/** Everyone's land over the match, for the chart on the results screen. */
export class LandHistory {
  readonly ticks: number[] = [];
  readonly tiles: Uint32Array[] = [];

  /** Call after the game steps; takes a sample whenever another game second has passed. */
  record(game: Game): void {
    const last = this.ticks.length ? this.ticks[this.ticks.length - 1] : -Infinity;
    if (game.phase === 'spawn' || game.tick - last < SAMPLE_EVERY) return;
    this.ticks.push(game.tick);
    this.tiles.push(Uint32Array.from(game.players, (p) => p.tiles));
  }
}

export interface ChartSeries {
  name: string;
  color: number;
  /** Share of all land at each sample, 0–1. */
  values: number[];
  me: boolean;
}

export interface ChartData {
  /** Seconds into the match at each sample. */
  seconds: number[];
  series: ChartSeries[];
}

/** You and the rivals who held the most land at their peak, in a fixed order (by player id). */
export function chartData(game: Game, history: LandHistory, meId: number | null): ChartData | null {
  if (history.ticks.length < 2) return null;
  const land = game.map.landTiles;
  const peak = game.players.map((_, i) => Math.max(...history.tiles.map((s) => s[i])));
  const rivals = game.players
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.id !== meId)
    .sort((a, b) => peak[b.i] - peak[a.i])
    .slice(0, RIVALS);
  const chosen = game.players.map((p, i) => ({ p, i })).filter(({ p }) => p.id === meId || rivals.some((r) => r.p === p));
  return {
    seconds: history.ticks.map((t) => t / CONFIG.ticksPerSecond),
    series: chosen.map(({ p, i }) => ({
      name: p.id === meId ? 'Du' : p.name,
      color: p.color,
      values: history.tiles.map((s) => s[i] / land),
      me: p.id === meId,
    })),
  };
}

const PAD = { left: 38, right: 10, top: 10, bottom: 22 };

/** A line chart of land share over time, with a legend and a hover readout. */
export function landChart(data: ChartData): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'land-chart';
  const caption = document.createElement('figcaption');
  caption.className = 'chart-title';
  caption.textContent = 'Land im Verlauf';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Landanteil im Verlauf der Partie: ${data.series.map((s) => `${s.name} zuletzt ${formatShare(s.values[s.values.length - 1])}`).join(', ')}`);
  const readout = document.createElement('p');
  readout.className = 'chart-readout';
  const legend = document.createElement('ul');
  legend.className = 'chart-legend';
  for (const s of data.series) {
    const li = document.createElement('li');
    if (s.me) li.className = 'me';
    const key = document.createElement('span');
    key.className = 'key';
    key.style.background = toHex(s.color);
    li.append(key, s.name);
    legend.append(li);
  }
  figure.append(caption, canvas, legend, readout);

  const n = data.seconds.length;
  const top = Math.max(0.1, Math.ceil(Math.max(...data.series.flatMap((s) => s.values)) * 10) / 10);
  let hover = -1;

  const draw = () => {
    const width = canvas.clientWidth || 380;
    const height = 150;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(figure);
    const muted = css.getPropertyValue('--ink-soft').trim() || '#9db5c4';
    const grid = css.getPropertyValue('--panel-edge').trim() || 'rgba(170,204,224,0.18)';
    const surface = css.getPropertyValue('--panel-solid').trim() || '#0c1c29';
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (n === 1 ? 0 : (i / (n - 1)) * plotW);
    const y = (v: number) => PAD.top + plotH * (1 - v / top);

    // Recessive grid and axis labels.
    ctx.font = '11px "Public Sans", system-ui, sans-serif';
    ctx.fillStyle = muted;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let k = 0; k <= 2; k++) {
      const v = (top * k) / 2;
      ctx.beginPath();
      ctx.moveTo(PAD.left, Math.round(y(v)) + 0.5);
      ctx.lineTo(PAD.left + plotW, Math.round(y(v)) + 0.5);
      ctx.stroke();
      ctx.fillText(formatShare(v).replace(',0', ''), PAD.left - 6, y(v));
    }
    ctx.textBaseline = 'top';
    for (const [i, align] of [[0, 'left'], [Math.floor((n - 1) / 2), 'center'], [n - 1, 'right']] as const) {
      ctx.textAlign = align;
      ctx.fillText(formatClock(data.seconds[i]), x(i), PAD.top + plotH + 6);
    }

    // Lines: rivals first, you on top and thicker.
    const order = [...data.series].sort((a, b) => Number(a.me) - Number(b.me));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of order) {
      ctx.beginPath();
      s.values.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
      // A thin surface halo keeps crossing lines apart.
      ctx.strokeStyle = surface;
      ctx.lineWidth = s.me ? 5 : 4;
      ctx.stroke();
      ctx.strokeStyle = toHex(s.color);
      ctx.lineWidth = s.me ? 3 : 2;
      ctx.stroke();
    }

    if (hover >= 0) {
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x(hover)) + 0.5, PAD.top);
      ctx.lineTo(Math.round(x(hover)) + 0.5, PAD.top + plotH);
      ctx.stroke();
      for (const s of order) {
        ctx.beginPath();
        ctx.arc(x(hover), y(s.values[hover]), 4, 0, Math.PI * 2);
        ctx.fillStyle = toHex(s.color);
        ctx.fill();
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  };

  const describe = (i: number) => {
    const ranked = [...data.series].sort((a, b) => b.values[i] - a.values[i]);
    readout.textContent = `${formatClock(data.seconds[i])}: ${ranked.map((s) => `${s.name} ${formatShare(s.values[i])}`).join(' · ')}`;
  };

  const onMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * (canvas.clientWidth || rect.width);
    const plotW = (canvas.clientWidth || rect.width) - PAD.left - PAD.right;
    hover = Math.min(n - 1, Math.max(0, Math.round(((px - PAD.left) / plotW) * (n - 1))));
    describe(hover);
    draw();
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onMove);
  canvas.addEventListener('pointerleave', () => {
    hover = -1;
    describe(n - 1);
    draw();
  });
  describe(n - 1);
  // Drawn once it is in the page and has a width.
  requestAnimationFrame(draw);
  return figure;
}
