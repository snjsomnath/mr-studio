import { formatValue } from '../bind.ts';
import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText } from './dom.ts';

/**
 * One of the layer's controls on a panel (#354): a slider, a toggle, a choice or a button, drawn
 * from the control's own definition in layer.json, so its label, range and choices are written once.
 * It changes the layer exactly as the controller's control does (the host checks it). Where a panel
 * can't be touched (the table's ribbon) it shows the value and does nothing.
 */
export const control = defineWidget({
  type: 'control',
  name: 'Control',
  description: "One of the layer's controls or named actions, as a slider, toggle, choice or button taken from its definition in layer.json.",
  sizes: ['chip', 'tile', 'wide'],
  props: {
    control: { kind: 'text', max: 40, label: 'Control or action id', required: true },
    label: { kind: 'text', max: TEXT.caption, label: 'Label (default: the control’s own)' },
  },
  // A button or a toggle is one thing to read; a slider or a choice is its label and its value.
  reads: (props, size) => (size === 'chip' ? 1 : 2),
  mount(el, env) {
    const box = h('div', `mrs-control mrs-control-${env.size}`);
    el.append(box);
    const controls = env.controls;
    const touch = controls?.touch === true;
    let built = '';
    let setValue: (value: unknown) => void = () => {};
    const build = (id: string, label: string | undefined) => {
      box.replaceChildren();
      const found = controls?.find(id);
      const title = label ?? found?.label ?? id;
      box.dataset.kind = found?.type ?? 'missing';
      if (!found) {
        box.append(h('p', 'mrs-caption', title));
        setValue = () => {};
        return;
      }
      if (found.type === 'action') {
        const press = h('button', 'mrs-control-button', title);
        press.type = 'button';
        press.disabled = !touch;
        press.addEventListener('click', () => touch && controls?.press(id));
        box.append(press);
        setValue = () => {};
        return;
      }
      if (found.type === 'toggle') {
        const press = h('button', 'mrs-control-toggle');
        press.type = 'button';
        press.setAttribute('role', 'switch');
        press.disabled = !touch;
        const knob = h('span', 'mrs-control-knob');
        press.append(knob, h('span', 'mrs-control-label', title));
        let on = false;
        press.addEventListener('click', () => touch && controls?.set(id, !on));
        box.append(press);
        setValue = (value) => {
          on = value === true;
          press.setAttribute('aria-checked', String(on));
        };
        return;
      }
      const head = h('div', 'mrs-control-head');
      const name = h('span', 'mrs-control-label', title);
      const shown = h('span', 'mrs-control-value');
      head.append(name, shown);
      box.append(head);
      if (found.type === 'range') {
        const slider = h('input', 'mrs-control-slider');
        slider.type = 'range';
        slider.min = String(found.min);
        slider.max = String(found.max);
        slider.step = String(found.step ?? (found.max - found.min) / 100);
        slider.disabled = !touch;
        slider.setAttribute('aria-label', title);
        const decimals = Math.max(0, Math.min(2, -Math.floor(Math.log10(Number(slider.step) || 1))));
        const show = (v: number) => setText(shown, `${formatValue(v, { decimals })}${found.unit ? ` ${found.unit}` : ''}`);
        slider.addEventListener('input', () => {
          show(Number(slider.value));
          if (touch) controls?.set(id, Number(slider.value));
        });
        box.append(slider);
        setValue = (value) => {
          if (typeof value !== 'number' || document.activeElement === slider) return;
          slider.value = String(value);
          show(value);
        };
        return;
      }
      if (found.type === 'select') {
        // Up to three choices side by side, as on the controller; more go in a list.
        const options = found.options;
        if (options.length <= 3) {
          const row = h('div', 'mrs-control-choices');
          row.setAttribute('role', 'radiogroup');
          row.setAttribute('aria-label', title);
          const buttons = options.map((option) => {
            const press = h('button', 'mrs-control-choice', option.label);
            press.type = 'button';
            press.setAttribute('role', 'radio');
            press.disabled = !touch;
            press.addEventListener('click', () => touch && controls?.set(id, option.value));
            row.append(press);
            return press;
          });
          box.append(row);
          setValue = (value) => {
            buttons.forEach((b, i) => b.setAttribute('aria-checked', String(options[i]!.value === value)));
            setText(shown, '');
          };
        } else {
          const list = h('select', 'mrs-control-select');
          list.disabled = !touch;
          list.setAttribute('aria-label', title);
          for (const option of options) {
            const item = h('option', '', option.label);
            item.value = option.value;
            list.append(item);
          }
          list.addEventListener('change', () => touch && controls?.set(id, list.value));
          box.append(list);
          setValue = (value) => {
            if (typeof value === 'string') list.value = value;
          };
        }
        return;
      }
      // Dates, colours and text stay on the controller: show the value.
      setValue = (value) => setText(shown, value === undefined ? '' : String(value));
    };
    return {
      update(props) {
        const id = String(props.control ?? '');
        const key = `${id}|${props.label ?? ''}`;
        if (key !== built) {
          built = key;
          build(id, props.label);
        }
        setValue(controls?.value(id));
      },
    };
  },
});
