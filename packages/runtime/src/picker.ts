import { icon } from './editor/icons.ts';

/**
 * A list to pick from, with type-ahead (#306): settings that name a dataset, a file, a column
 * or a map service's layer use it instead of a box to type the name in. Typing filters the
 * list; a name that is not in it is refused and says so, so a misspelt name never reaches a layer.
 */

export interface Choice {
  /** What is stored. */
  value: string;
  /** What people see. */
  label: string;
  /** A second, quieter line: a file name, a size, a kind. */
  detail?: string;
  /** Choices are listed under their group's heading, in the order the groups first appear. */
  group?: string;
  icon?: string;
}

/** An entry at the foot of the list that does something, such as Add media. */
export interface PickerAction {
  label: string;
  icon: string;
  /** Answers the value to pick afterwards, or null to leave the choice as it was. */
  run(): Promise<string | null> | string | null | void;
}

export interface PickerOptions {
  id: string;
  /** For screen readers and the "not in the list" note. */
  label: string;
  /** The first choice, for an empty value, such as "None" or "Built-in birdsong". Omit when a value is required. */
  none?: string;
  /** Several values, joined with commas (a WMS service's layers). */
  multiple?: boolean;
  /** Asked each time the list opens; may be slow (a service's layers). */
  load(): Promise<Choice[]>;
  actions?: PickerAction[];
  /** Words while `load` runs, and when it fails or finds nothing. */
  loading?: string;
  empty?: string;
  /** False: the list is asked for only when it opens (it reaches out to a service). Default true. */
  eager?: boolean;
  pick(value: string): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const split = (value: string): string[] =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

export class Picker {
  readonly element = el('div', 'picker');
  private readonly input = el('input', 'picker-input');
  private readonly toggle = el('button', 'picker-toggle');
  private readonly list = el('div', 'picker-list');
  private readonly note = el('p', 'picker-note');
  private choices: Choice[] = [];
  private loaded = false;
  private failed = '';
  private value = '';
  private active = -1;
  private shown: (Choice | PickerAction)[] = [];
  private open = false;

  private readonly options: PickerOptions;

  constructor(options: PickerOptions) {
    this.options = options;
    const { input, toggle, list } = this;
    input.id = options.id;
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    list.id = `${options.id}-list`;
    list.setAttribute('role', 'listbox');
    input.setAttribute('aria-controls', list.id);
    toggle.type = 'button';
    toggle.tabIndex = -1;
    toggle.ariaLabel = `Show the choices for ${options.label}`;
    toggle.append(icon('chevron', 14));
    list.hidden = true;
    this.note.hidden = true;
    const field = el('div', 'picker-field');
    field.append(input, toggle);
    this.element.append(field, list, this.note);

    input.addEventListener('focus', () => {
      input.select();
      void this.show();
    });
    input.addEventListener('click', () => void this.show());
    input.addEventListener('input', () => {
      this.note.hidden = true;
      void this.show(input.value);
    });
    input.addEventListener('keydown', (event) => this.key(event));
    // A click in the list must not blur first and close it.
    list.addEventListener('pointerdown', (event) => event.preventDefault());
    toggle.addEventListener('pointerdown', (event) => event.preventDefault());
    toggle.addEventListener('click', () => {
      if (this.open) this.close();
      else {
        input.focus();
        void this.show();
      }
    });
    input.addEventListener('blur', () => this.settle());
    this.draw();
    if (options.eager !== false) void this.ensure().then(() => document.activeElement !== this.input && this.draw());
  }

  /** Shows a value from the host. Left alone while someone is typing. */
  set(value: string): void {
    this.value = value;
    if (document.activeElement !== this.input) this.draw();
  }

  /** The list asks for its choices again the next time it opens (something was added). */
  forget(): void {
    this.loaded = false;
    if (this.open) void this.show(this.typed());
    else void this.ensure().then(() => this.draw());
  }

  private typed(): string {
    const text = this.input.value;
    // Several values: what is being typed is the part after the last comma.
    return this.options.multiple ? (text.split(',').pop() ?? '').trim() : text;
  }

  private async ensure(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.failed = '';
    try {
      this.choices = await this.options.load();
    } catch (error) {
      this.choices = [];
      this.failed = (error as Error).message;
    }
  }

  private labelOf(value: string): string {
    if (!value) return '';
    return this.options.multiple ? split(value).map((v) => this.choices.find((c) => c.value === v)?.label ?? v).join(', ') : (this.choices.find((c) => c.value === value)?.label ?? value);
  }

  /** The box shows the chosen label, and says when the chosen thing is not in the table. */
  private draw(): void {
    this.input.value = this.labelOf(this.value);
    this.input.placeholder = this.options.none ?? 'Choose…';
    const values = this.options.multiple ? split(this.value) : this.value ? [this.value] : [];
    const missing = this.loaded && !this.failed ? values.filter((v) => !this.choices.some((c) => c.value === v)) : [];
    this.element.classList.toggle('is-missing', missing.length > 0);
    if (missing.length > 0) this.say(`${missing.map((m) => `“${m}”`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in this table. Pick ${missing.length === 1 ? 'another' : 'others'} from the list.`);
    else if (this.note.dataset.kind === 'missing') this.note.hidden = true;
    this.note.dataset.kind = missing.length > 0 ? 'missing' : '';
  }

  private say(text: string): void {
    this.note.textContent = text;
    this.note.hidden = false;
  }

  private async show(filter = ''): Promise<void> {
    const waiting = !this.loaded;
    this.open = true;
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    if (waiting) this.list.replaceChildren(el('p', 'picker-empty', this.options.loading ?? 'Looking…'));
    await this.ensure();
    if (!this.open) return;
    if (waiting && document.activeElement === this.input && !filter) this.draw();
    this.render(filter);
  }

  private render(filter: string): void {
    const words = filter.trim().toLowerCase();
    const chosen = new Set(this.options.multiple ? split(this.value) : [this.value]);
    // While the box shows the chosen label, the whole list is offered.
    const showing = !words || words === this.labelOf(this.value).toLowerCase();
    const matches = this.choices.filter((c) => showing || `${c.label} ${c.value} ${c.detail ?? ''} ${c.group ?? ''}`.toLowerCase().includes(words));
    const nodes: HTMLElement[] = [];
    this.shown = [];
    if (this.options.none !== undefined && (showing || this.options.none.toLowerCase().includes(words)) && !this.options.multiple) {
      nodes.push(this.row({ value: '', label: this.options.none }, chosen.has('')));
    }
    let group: string | undefined;
    for (const choice of matches) {
      if (choice.group && choice.group !== group) {
        group = choice.group;
        nodes.push(el('div', 'picker-group', group));
      }
      nodes.push(this.row(choice, chosen.has(choice.value)));
    }
    if (matches.length === 0) {
      const text = this.failed ? `Could not get the list: ${this.failed}` : words && this.choices.length ? `Nothing here is called “${filter.trim()}”.` : (this.options.empty ?? 'Nothing to choose yet.');
      nodes.push(el('p', 'picker-empty', text));
    }
    for (const action of this.options.actions ?? []) {
      const node = el('button', 'picker-action');
      node.type = 'button';
      node.tabIndex = -1;
      node.append(icon(action.icon, 14), el('span', undefined, action.label));
      node.addEventListener('click', () => void this.act(action));
      this.shown.push(action);
      node.dataset.index = String(this.shown.length - 1);
      nodes.push(node);
    }
    this.list.replaceChildren(...nodes);
    // The first match is ready for Enter when something was typed.
    this.highlight(words && !showing ? this.shown.findIndex((s) => 'value' in s) : -1);
  }

  private row(choice: Choice, selected: boolean): HTMLElement {
    const node = el('button', 'picker-option');
    node.type = 'button';
    node.tabIndex = -1;
    node.setAttribute('role', 'option');
    node.setAttribute('aria-selected', String(selected));
    const text = el('span', 'picker-option-text');
    text.append(el('span', 'picker-option-label', choice.label));
    if (choice.detail) text.append(el('span', 'picker-option-detail', choice.detail));
    node.append(choice.icon ? icon(choice.icon, 14) : el('span', 'picker-option-blank'), text);
    if (selected) node.append(icon('check', 14));
    node.addEventListener('click', () => this.choose(choice.value));
    this.shown.push(choice);
    node.dataset.index = String(this.shown.length - 1);
    return node;
  }

  private highlight(index: number): void {
    this.active = index;
    for (const node of this.list.querySelectorAll<HTMLElement>('[data-index]')) {
      const on = Number(node.dataset.index) === index;
      node.classList.toggle('is-active', on);
      if (on) node.scrollIntoView({ block: 'nearest' });
    }
  }

  private choose(value: string): void {
    this.note.hidden = true;
    if (this.options.multiple && value) {
      const values = split(this.value);
      const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
      this.value = next.join(',');
      this.options.pick(this.value);
      this.input.value = this.labelOf(this.value);
      this.render('');
      return;
    }
    this.value = value;
    this.options.pick(value);
    this.close();
    this.draw();
  }

  private async act(action: PickerAction): Promise<void> {
    this.close();
    const value = await action.run();
    this.loaded = false;
    await this.ensure();
    if (typeof value === 'string') this.choose(value);
    else this.draw();
  }

  private close(): void {
    this.open = false;
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
  }

  /** Leaving the box: what was typed must be one of the choices, or the choice stays as it was. */
  private settle(): void {
    if (!this.open && this.input.value === this.labelOf(this.value)) return;
    this.close();
    const typed = this.typed().trim().toLowerCase();
    if (this.options.multiple || !typed || typed === this.labelOf(this.value).toLowerCase()) {
      if (!this.options.multiple && !typed && this.options.none !== undefined && this.value) this.choose('');
      this.draw();
      return;
    }
    const exact = this.choices.find((c) => c.value.toLowerCase() === typed || c.label.toLowerCase() === typed);
    if (exact) {
      this.choose(exact.value);
      return;
    }
    const text = this.input.value.trim();
    this.draw();
    this.say(`There is no “${text}” in this table, so ${this.options.label.toLowerCase()} stays as it was. Pick one from the list.`);
  }

  private key(event: KeyboardEvent): void {
    const count = this.shown.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.open) {
        void this.show();
        return;
      }
      if (count === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.highlight((this.active + step + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = this.shown[this.active];
      if (!target) {
        this.settle();
        return;
      }
      if ('value' in target) this.choose(target.value);
      else void this.act(target);
    } else if (event.key === 'Escape') {
      if (!this.open) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
      this.draw();
    }
  }
}
