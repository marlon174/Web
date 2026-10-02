/**
 * Every sound is synthesised with Web Audio, so there are no files to load.
 * The audio context starts on the first tap or key press, as browsers require.
 */
export type SoundName =
  | 'click'
  | 'build'
  | 'launch'
  | 'boom'
  | 'bigBoom'
  | 'train'
  | 'good'
  | 'bad'
  | 'alliance'
  | 'win'
  | 'lose';

/** Shortest gap between two plays of the same sound, so a busy tick doesn't stack them up. */
const MIN_GAP_MS: Record<SoundName, number> = {
  click: 40,
  build: 80,
  launch: 150,
  boom: 120,
  bigBoom: 300,
  train: 1500,
  good: 300,
  bad: 300,
  alliance: 500,
  win: 2000,
  lose: 2000,
};

class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.5;
  private readonly lastPlayed = new Map<SoundName, number>();

  constructor() {
    const unlock = () => {
      this.ensure();
      if (this.ctx?.state === 'suspended') void this.ctx.resume();
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  /** 0 (muted) to 1. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master) this.master.gain.value = this.volume * 0.6;
  }

  /** Plays a sound; `loudness` (0–1) scales it, e.g. for things happening to other players. */
  play(name: SoundName, loudness = 1): void {
    if (this.volume <= 0 || loudness <= 0) return;
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(name) ?? -Infinity) < MIN_GAP_MS[name]) return;
    this.lastPlayed.set(name, now);
    const out = ctx.createGain();
    out.gain.value = loudness;
    out.connect(this.master);
    const t = ctx.currentTime + 0.005;
    switch (name) {
      case 'click':
        this.tone(out, t, 660, 660, 0.05, 0.25, 'triangle');
        break;
      case 'build':
        this.tone(out, t, 330, 330, 0.08, 0.35, 'square');
        this.tone(out, t + 0.09, 495, 495, 0.1, 0.3, 'square');
        break;
      case 'launch':
        this.tone(out, t, 180, 900, 0.7, 0.3, 'sawtooth');
        this.hiss(out, t, 0.8, 0.25, 2500);
        break;
      case 'boom':
        this.hiss(out, t, 0.7, 0.9, 700);
        this.tone(out, t, 120, 40, 0.5, 0.8, 'sine');
        break;
      case 'bigBoom':
        this.hiss(out, t, 2.2, 1, 500);
        this.tone(out, t, 90, 25, 1.8, 1, 'sine');
        break;
      case 'train':
        // Two-tone whistle.
        this.tone(out, t, 740, 740, 0.35, 0.18, 'square');
        this.tone(out, t, 880, 880, 0.35, 0.14, 'square');
        this.tone(out, t + 0.42, 740, 740, 0.5, 0.18, 'square');
        this.tone(out, t + 0.42, 880, 880, 0.5, 0.14, 'square');
        break;
      case 'good':
        this.tone(out, t, 523, 523, 0.1, 0.3, 'triangle');
        this.tone(out, t + 0.1, 784, 784, 0.18, 0.3, 'triangle');
        break;
      case 'bad':
        this.tone(out, t, 330, 330, 0.12, 0.3, 'sawtooth');
        this.tone(out, t + 0.13, 233, 233, 0.25, 0.3, 'sawtooth');
        break;
      case 'alliance':
        this.tone(out, t, 392, 392, 0.12, 0.3, 'triangle');
        this.tone(out, t + 0.12, 523, 523, 0.12, 0.3, 'triangle');
        this.tone(out, t + 0.24, 659, 659, 0.25, 0.3, 'triangle');
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(out, t + i * 0.16, f, f, i === 3 ? 0.7 : 0.18, 0.35, 'square'));
        break;
      case 'lose':
        [392, 349, 311, 262].forEach((f, i) => this.tone(out, t + i * 0.22, f, f, i === 3 ? 0.8 : 0.24, 0.3, 'triangle'));
        break;
    }
  }

  private ensure(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume * 0.6;
    this.master.connect(this.ctx.destination);
    // One second of white noise, reused for every blast and hiss.
    const length = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  /** A note gliding from `f0` to `f1` Hz, fading out over `duration` seconds. */
  private tone(out: AudioNode, t: number, f0: number, f1: number, duration: number, gain: number, type: OscillatorType): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /** Filtered noise: rumble (low cutoff) or hiss (high cutoff). */
  private hiss(out: AudioNode, t: number, duration: number, gain: number, cutoff: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, cutoff / 6), t + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(env).connect(out);
    src.start(t);
    src.stop(t + duration + 0.05);
  }
}

export const sound = new SoundBoard();
