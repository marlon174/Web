import { t } from './i18n';

/** Where the game lives; shared results link here. */
export const GAME_URL = 'https://marlon174.github.io/Web/';

/**
 * Shares a line about a match: the system share sheet where there is one
 * (phones, tablets), otherwise the clipboard. Resolves to what happened.
 */
export async function share(text: string): Promise<'shared' | 'copied' | 'failed'> {
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (nav.share) {
    try {
      await nav.share({ title: 'Landgrab', text, url: GAME_URL });
      return 'shared';
    } catch (e) {
      // Closing the sheet isn't a failure worth a fallback.
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${GAME_URL}`);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** The toast after sharing. */
export function shareNote(result: 'shared' | 'copied' | 'failed'): string | null {
  if (result === 'copied') return t('Kopiert! Füg es in einen Chat ein.', 'Copied! Paste it into a chat.');
  if (result === 'failed') return t('Teilen ging leider nicht.', 'Sharing didn\'t work.');
  return null;
}
