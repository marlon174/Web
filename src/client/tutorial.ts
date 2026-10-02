import { NEUTRAL, type Game, type Player } from '../core/game';
import { byId } from './hud';

interface Step {
  title: string;
  text: string;
  /** True once the player has done what the step asks. */
  done(game: Game, me: Player, start: { tiles: number }): boolean;
}

const STEPS: Step[] = [
  {
    title: 'Startpunkt wählen',
    text: 'Klick auf eine Stelle an Land, am besten auf grüne Wiese. Dort beginnt dein Reich.',
    done: (_, me) => me.spawned,
  },
  {
    title: 'Ausbreiten',
    text: 'Klick auf das freie Land neben deinem Gebiet. Deine Truppen erobern es Feld für Feld.',
    done: (_, me) => me.tiles >= 150,
  },
  {
    title: 'Mehr Truppen schicken',
    text: 'Der Regler „Senden“ unten bestimmt, wie viele Truppen ein Klick losschickt. Stell ihn höher und klick wieder auf freies Land.',
    done: (_, me) => me.tiles >= 500,
  },
  {
    title: 'Eine Stadt bauen',
    text: 'Drück Q oder tippe unten auf „Stadt“, dann klick auf dein Land. Städte erhöhen, wie viele Truppen du haben kannst.',
    done: (_, me) => me.owned.city >= 1,
  },
  {
    title: 'Angreifen',
    text: 'Breite dich weiter aus, bis du an einen Nachbarn grenzt. Dann klick auf sein Land. Je mehr Truppen du schickst, desto schneller geht es (⚡).',
    done: (game, me) => game.attacks.some((a) => a.attacker === me.id && a.target !== NEUTRAL),
  },
];

/** The guided first match: one step at a time on a card under the clock. */
export class Tutorial {
  private readonly card = byId('coach');
  private readonly stepEl = byId('coach-step');
  private readonly titleEl = byId('coach-title');
  private readonly textEl = byId('coach-text');
  private readonly doneEl = byId<HTMLButtonElement>('coach-done');
  private step = 0;
  private readonly start = { tiles: 0 };
  /** Called once every step is done (true) or when the player skips the rest (false). */
  onFinish: (completed: boolean) => void = () => {};

  constructor() {
    byId('coach-skip').onclick = () => this.finish(false);
    this.doneEl.onclick = () => this.hide();
    this.show();
  }

  get active(): boolean {
    return !this.card.hidden;
  }

  update(game: Game, me: Player): void {
    if (this.step >= STEPS.length || this.card.hidden) return;
    let moved = false;
    while (this.step < STEPS.length && STEPS[this.step].done(game, me, this.start)) {
      this.step++;
      moved = true;
    }
    if (!moved) return;
    if (this.step >= STEPS.length) this.finish(true);
    else this.show();
  }

  hide(): void {
    this.card.hidden = true;
  }

  private show(): void {
    const s = STEPS[this.step];
    this.stepEl.textContent = `Tutorial · Schritt ${this.step + 1} von ${STEPS.length}`;
    this.titleEl.textContent = s.title;
    this.textEl.textContent = s.text;
    this.card.classList.remove('finished');
    this.card.hidden = false;
  }

  private finish(completed: boolean): void {
    this.step = STEPS.length;
    if (completed) {
      this.stepEl.textContent = 'Tutorial geschafft';
      this.titleEl.textContent = 'Du kennst jetzt die Grundlagen!';
      this.textEl.textContent = 'Erobere die Insel weiter, oder starte über das Menü ein richtiges Spiel. Weitere Tipps kommen, wenn sie passen.';
      this.card.classList.add('finished');
    } else {
      this.hide();
    }
    this.onFinish(completed);
  }
}
