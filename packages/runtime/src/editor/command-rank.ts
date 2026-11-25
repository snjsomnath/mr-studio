/** Command search ranking (#65, #464), kept apart from the dialog so it can be tested on its own. */
export interface Command {
  id: string;
  label: string;
  /** Where it belongs, shown on the right: Layer, Add, Data, View... */
  group: string;
  icon?: string;
  keys?: string;
  /** More words it answers to. */
  also?: string;
  disabled?: string;
  run: () => void;
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9%]+/)
    .filter(Boolean);

/**
 * How well a command answers a search (#464). The whole query is compared with the label first:
 * the exact label, then a label that starts with it, then the phrase inside the label, then all
 * its words somewhere in the label. Words found only in the group or the extra words rank last.
 * Each tier is worth 1000, so a better tier always comes first; within one, earlier and shorter wins.
 */
export function score(command: Command, query: string): number {
  const wanted = words(query);
  if (wanted.length === 0) return 1;
  const label = words(command.label);
  const extra = words(`${command.group} ${command.also ?? ''}`);
  // Every word must start a word of the label or of the extra words; otherwise it is no match.
  const starts = (list: string[], word: string) => list.findIndex((w) => w.startsWith(word));
  if (!wanted.every((w) => starts(label, w) >= 0 || starts(extra, w) >= 0)) return 0;
  const shorter = Math.max(0, 40 - label.length * 4);
  const phrase = wanted.join(' ');
  const text = label.join(' ');
  if (text === phrase) return 5000;
  if (text.startsWith(phrase)) return 4000 + shorter;
  // The phrase inside the label, from the start of a word.
  const at = ` ${text}`.indexOf(` ${phrase}`);
  if (at >= 0) return 3000 + shorter - Math.min(at, 40);
  if (wanted.every((w) => starts(label, w) >= 0)) {
    let fine = 0;
    for (const w of wanted) fine += 10 - Math.min(starts(label, w), 8) + (label.includes(w) ? 2 : 0);
    return 2000 + fine * 4 + shorter;
  }
  let fine = 0;
  for (const w of wanted) fine += starts(label, w) >= 0 ? 10 : 2;
  return 1000 + fine;
}

/** The tier of a score: 5 exact … 1 only the extra words. */
export const tier = (s: number): number => Math.floor(s / 1000);

/**
 * The commands to show for a query, best first. Once something matches the label in full,
 * matches through the extra words alone are noise and are left out (#464).
 */
export function rank(commands: Command[], query: string, limit = 40): Command[] {
  const scored = commands
    .map((c, i) => ({ c, s: score(c, query), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const top = scored.length ? tier(scored[0]!.s) : 0;
  return scored
    .filter((x) => top < 2 || tier(x.s) >= 2)
    .slice(0, limit)
    .map((x) => x.c);
}
