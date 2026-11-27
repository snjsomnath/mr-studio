// The editor's saved, saving and problem states (#68, #575), apart from the editor (#540): every
// change goes to the host through `send`, and the title bar's button says where it stands. No
// DOM here, so the rules can be tested on their own; the editor draws the words it is given.

/** What the saved button says, and how it looks. */
export interface SaveWords {
  /** The words on the button. */
  text: string;
  /** Its tooltip. */
  title: string;
  /** The icon beside the words: none while saving, which shows a spinner. */
  icon: 'check' | 'alert' | null;
  /** Drawn as a problem. */
  error: boolean;
}

/** How long a change may wait for the host before the button says Saving… */
export const SLOW_SAVE_MS = 300;
/** How long `settled` waits for every change to be answered. */
export const SETTLE_MS = 5000;

/** The words while a change waits for the host. */
export function savingWords(): SaveWords {
  return { text: 'Saving…', title: 'Waiting for the table to confirm the change', icon: null, error: false };
}

/** The words once the host has answered: saved at `time`, or the problem. A read-only copy never says Saved (#575). */
export function savedWords(time: string, readOnly: boolean, problem?: string | null): SaveWords {
  if (problem) return { text: problem, title: 'This change could not be saved. Click for the history.', icon: 'alert', error: true };
  return {
    text: readOnly ? `Kept in the copy ${time}` : `Saved ${time}`,
    title: readOnly
      ? `A read-only copy: changes stay in this copy and never reach the table. File › Save As… keeps them as a new table. Click for the history.`
      : `Every change is saved as you make it. Last saved at ${time}. Click for the history.`,
    icon: 'check',
    error: false,
  };
}

/** The time as the button shows it. */
const clockTime = (): string => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Changes on their way to the host, and the last answer. */
export class SaveState {
  /** Changes sent to the host and not yet answered. */
  pending = 0;
  /** Why the last change could not be saved, until one is. */
  problem: string | null = null;

  private readonly draw: (words: SaveWords) => void;
  private readonly readOnly: () => boolean;
  private readonly now: () => string;

  constructor(draw: (words: SaveWords) => void, readOnly: () => boolean, now: () => string = clockTime) {
    this.draw = draw;
    this.readOnly = readOnly;
    this.now = now;
  }

  /** Sends one change: says Saving… if the host takes a moment, then Saved or the problem. A refused change answers null. */
  async send<T>(request: () => Promise<T>): Promise<T | null> {
    this.pending++;
    // A change the host has not confirmed in a moment says so, rather than claiming it is saved (#68).
    const slow = setTimeout(() => this.pending > 0 && this.saving(), SLOW_SAVE_MS);
    try {
      const result = await request();
      this.saved();
      return result;
    } catch (error) {
      this.saved((error as Error).message);
      return null;
    } finally {
      clearTimeout(slow);
      this.pending--;
    }
  }

  /** Says the change is on its way. */
  saving(): void {
    this.draw(savingWords());
  }

  /** Says the change is saved, or why it is not. */
  saved(problem?: string): void {
    this.problem = problem ?? null;
    this.draw(savedWords(this.now(), this.readOnly(), problem));
  }

  /** Waits until every change sent to the host has been answered, for up to `SETTLE_MS`. */
  async settled(): Promise<void> {
    for (let waited = 0; this.pending > 0 && waited < SETTLE_MS; waited += 50) await new Promise((r) => setTimeout(r, 50));
  }
}
