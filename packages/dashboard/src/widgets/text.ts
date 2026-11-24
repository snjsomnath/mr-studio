import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText } from './dom.ts';

/** A sentence or two, for what a number cannot say. */
export const text = defineWidget({
  type: 'text',
  name: 'Note',
  description: 'One or two sentences. For explaining what the table shows, not for paragraphs.',
  sizes: ['tile', 'wide'],
  example: { body: 'Tap a building on the table to see what its roof makes.' },
  props: {
    body: { kind: 'text', max: TEXT.line * 2, label: 'Text', required: true, bindable: true },
  },
  reads: () => 2,
  mount(el) {
    const body = h('p', 'mrs-note');
    el.append(body);
    return { update: (props) => setText(body, props.body ?? '') };
  },
});
