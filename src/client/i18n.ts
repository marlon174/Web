/**
 * Two languages, German and English. Strings sit side by side where they
 * are used, t('Freies Land', 'Free land'), so both stay easy to read and
 * to keep in step. The language is read once at start; switching it in the
 * settings reloads the page.
 */
export type Lang = 'de' | 'en';

const KEY = 'landgrab.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'de' || saved === 'en') return saved;
  } catch {
    // No storage: fall back to the browser's language.
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'de';
  return nav.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export const lang: Lang = detect();

export function t(de: string, en: string): string {
  return lang === 'en' ? en : de;
}

export function setLang(next: Lang): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Can't remember it: the reload falls back to the browser's language.
  }
  location.reload();
}

/** Number formatting for the current language: 1.234 / 1,234 and 7,5 / 7.5. */
export const decimal = lang === 'en' ? '.' : ',';
export const locale = lang === 'en' ? 'en-US' : 'de-DE';

/**
 * Swaps the static page text to English: elements carry their English in
 * data-en (text), data-en-placeholder, data-en-label (aria-label) and
 * data-en-title.
 */
export function translatePage(): void {
  document.documentElement.lang = lang;
  if (lang !== 'en') return;
  for (const el of document.querySelectorAll<HTMLElement>('[data-en]')) el.textContent = el.dataset.en!;
  for (const el of document.querySelectorAll<HTMLElement>('[data-en-html]')) el.innerHTML = el.dataset.enHtml!;
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-en-placeholder]')) el.placeholder = el.dataset.enPlaceholder!;
  for (const el of document.querySelectorAll<HTMLElement>('[data-en-label]')) el.setAttribute('aria-label', el.dataset.enLabel!);
  for (const el of document.querySelectorAll<HTMLElement>('[data-en-title]')) el.title = el.dataset.enTitle!;
}
