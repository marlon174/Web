/** 950, 12.4K, 480K, 1.25M */
export function formatTroops(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v < 1000) return String(v);
  if (v < 100_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '').replace('.', ',')}K`;
  if (v < 1_000_000) return `${Math.floor(v / 1000)}K`;
  return `${(v / 1_000_000).toFixed(v < 10_000_000 ? 2 : 1).replace('.', ',')}M`;
}

/** m:ss */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 0.4%, 7.5%, 38% */
export function formatShare(share: number): string {
  const p = share * 100;
  return p >= 10 ? `${Math.round(p)} %` : `${p.toFixed(1).replace('.', ',')} %`;
}

export function formatCount(n: number): string {
  return Math.floor(n).toLocaleString('de-DE');
}
