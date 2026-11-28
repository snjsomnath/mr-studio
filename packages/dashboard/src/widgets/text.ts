import { formatClock, formatCompact, formatUnit } from '@mrstudio/sdk';

import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h } from './dom.ts';

/** The most live values one text box weaves in (#671). */
export const TEXT_VALUES = 4;
/** The longest a box's words may be once its values are in, worst case. */
export const TEXT_BODY = TEXT.line * 2;

/** The most characters a text box holds at a size (#671): a tile holds about five short lines, a wide box twice that. */
export function textLimit(size: string): number {
  return size === 'tile' ? TEXT.line : TEXT_BODY;
}
/** What a slot may take up at most: a value as the screen shows it, a space and a unit. */
const SLOT_WORST = TEXT.value + 1 + TEXT.unit;

/** How a value in a text box is written. */
export const TEXT_FORMATS = ['number', 'percent', 'compact', 'hour'] as const;

/** One piece of a text box: plain words, bold words, or a live value. */
export type TextPiece = { text: string; bold?: boolean } | { slot: string; bold?: boolean };

/**
 * Splits a text box's words into pieces (#671): `{{name}}` is one of its values, and `**words**`
 * are bold. Nothing else is markup, so a layer's words cannot draw anything but text.
 */
export function parseTemplate(body: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let bold = false;
  for (const part of body.split(/(\*\*|\{\{\s*[a-z][a-z0-9_-]*\s*\}\})/i)) {
    if (part === '**') bold = !bold;
    else if (part.startsWith('{{') && part.endsWith('}}')) pieces.push({ slot: part.slice(2, -2).trim(), ...(bold ? { bold } : {}) });
    else if (part) pieces.push({ text: part, ...(bold ? { bold } : {}) });
  }
  return pieces;
}

/** The names a template asks for, in order. */
export function templateSlots(body: string): string[] {
  return parseTemplate(body).flatMap((p) => ('slot' in p ? [p.slot] : []));
}

/**
 * Why a text box's words don't work with its values, or an empty list (#671): every `{{name}}` is
 * one of its values, every value is used, and the words with every value at its longest still fit
 * the box. A longer text is refused here rather than drawn smaller on the screen.
 */
export function templateProblems(body: unknown, values: unknown, size: string, bound = false): string[] {
  if (typeof body !== 'string') return [];
  const names = Array.isArray(values) ? values.map((v) => (v as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string') : [];
  const slots = templateSlots(body);
  const problems: string[] = [];
  // Values bound as a whole arrive with their names; only their length can be checked here.
  if (!bound) for (const slot of new Set(slots)) if (!names.includes(slot)) problems.push(`{{${slot}}} is not one of its values (${names.join(', ') || 'it has none'})`);
  if (Array.isArray(values)) for (const name of names) if (!slots.includes(name)) problems.push(`the value '${name}' is not used in the text`);
  if (new Set(names).size !== names.length) problems.push('two values have the same name');
  const words = parseTemplate(body).reduce((n, p) => n + ('slot' in p ? SLOT_WORST : [...p.text].length), 0);
  const most = textLimit(size);
  if (words > most) problems.push(`${slots.length ? 'with its values at their longest ' : ''}the text is ${words} characters, a ${size} text box holds ${most}. Say it in fewer words${size === 'tile' ? ' or use a wide box' : ''}`);
  return problems;
}

/**
 * The longest a text box may be at a size (#681): as many values as its budget allows, each at its
 * longest, and words up to the limit. The overflow check draws this.
 */
export function worstText(values: Record<string, unknown>[], size: string, words: (max: number) => string): { body: string; values: Record<string, unknown>[] } {
  const kept = values.slice(0, size === 'tile' ? 2 : TEXT_VALUES).map((v, i) => ({ ...v, name: typeof v.name === 'string' ? v.name : `v${i}`, value: 98765.4, decimals: 1, unit: words(TEXT.unit), format: 'number' }));
  const slots = kept.map((v) => `{{${v.name}}}`);
  const room = textLimit(size) - kept.length * SLOT_WORST - kept.length;
  return { body: [words(Math.max(0, room)), ...slots].join(' '), values: kept };
}

interface TextValue {
  name?: string;
  value?: number | string;
  format?: (typeof TEXT_FORMATS)[number];
  decimals?: number;
  unit?: string;
  accent?: boolean;
}

/** A value as a text box writes it, in the visitors' language (#80). */
export function writeValue(v: TextValue | undefined): string {
  const value = v?.value;
  if (value === undefined || value === null || value === '') return '–';
  if (typeof value === 'string') return v?.unit ? `${value}\u00a0${v.unit}` : value;
  if (v?.format === 'hour') return formatClock(value);
  if (v?.format === 'compact') return v.unit ? `${formatCompact(value)}\u00a0${v.unit}` : formatCompact(value);
  if (v?.format === 'percent') return formatUnit(value * 100, '%', v.decimals ?? 0);
  return formatUnit(value, v?.unit, v?.decimals ?? 0);
}

/** A sentence or two, for what a number cannot say. With values, a sentence that reads live numbers (#671). */
export const text = defineWidget({
  type: 'text',
  name: 'Note',
  description: 'One or two sentences. For explaining what the table shows, not for paragraphs. {{name}} writes one of its values in, **words** are bold.',
  sizes: ['tile', 'wide'],
  example: {
    body: '**{{kwh}}** today, {{delta}} more than a year ago.',
    values: [
      { name: 'kwh', value: 1234, unit: 'kWh', accent: true },
      { name: 'delta', value: 0.12, format: 'percent' },
    ],
  },
  props: {
    body: { kind: 'text', max: TEXT_BODY, label: 'Text', required: true, bindable: true },
    values: {
      kind: 'list',
      max: TEXT_VALUES,
      label: 'Values',
      item: {
        name: { kind: 'text', max: 16, label: 'Name', required: true },
        value: { kind: 'value', label: 'Value', required: true, bindable: true },
        format: { kind: 'enum', options: [...TEXT_FORMATS], label: 'Written as', default: 'number' },
        decimals: { kind: 'number', min: 0, max: 3, label: 'Decimals' },
        unit: { kind: 'text', max: TEXT.unit, label: 'Unit' },
        accent: { kind: 'boolean', label: 'In the accent colour' },
      },
    },
  },
  // Words count as two reads, as before; each live value is one more thing to take in.
  reads: (props) => 2 + Math.ceil(Math.min(Array.isArray(props.values) ? props.values.length : 0, TEXT_VALUES) / 2),
  mount(el) {
    const body = h('p', 'mrs-note');
    el.append(body);
    let drawn = '';
    return {
      update(props) {
        const values = new Map<string, TextValue>((Array.isArray(props.values) ? (props.values as TextValue[]) : []).map((v) => [v.name ?? '', v]));
        const pieces = parseTemplate(String(props.body ?? '')).map((p) => ('slot' in p ? { ...p, text: writeValue(values.get(p.slot)), accent: values.get(p.slot)?.accent } : p));
        const key = JSON.stringify(pieces);
        if (key === drawn) return;
        drawn = key;
        body.replaceChildren(
          ...pieces.map((p) => {
            const plain = !p.bold && !('accent' in p && p.accent) && !('slot' in p);
            if (plain) return document.createTextNode(p.text);
            const span = h(p.bold ? 'strong' : 'span', 'slot' in p ? 'mrs-note-value' : 'mrs-note-bold', p.text);
            if ('accent' in p && p.accent) span.classList.add('mrs-note-accent');
            return span;
          }),
        );
      },
    };
  },
});
