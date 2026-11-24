import { defineWidget } from '../registry.ts';

/**
 * The escape hatch: the layer's own `panel` function draws inside the panel.
 * It still has a fixed size, a title and a declared cost, and what does not fit is clipped.
 */
export const custom = defineWidget({
  type: 'custom',
  name: 'Custom',
  description: 'Drawn by the layer\'s own code, for what no widget covers. It declares its own cost in reads.',
  sizes: ['chip', 'tile', 'wide', 'tall', 'block', 'hero', 'band', 'strip'],
  example: { reads: 1 },
  props: {
    reads: { kind: 'number', min: 1, max: 10, label: 'Reads it asks for', required: true },
  },
  reads: (props) => props.reads ?? 1,
  mount(el, env) {
    const handlers = env.custom?.(el);
    return { update: () => handlers?.update?.() };
  },
});
