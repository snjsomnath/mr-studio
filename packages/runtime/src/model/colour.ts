import type * as THREE from 'three';

const colourParser = document.createElement('canvas').getContext('2d')!;

/** Any CSS colour as a three.js colour. The canvas normalises it to a form three.js reads. */
export function cssColor(value: string, into: THREE.Color): THREE.Color {
  colourParser.fillStyle = '#ffffff';
  colourParser.fillStyle = value;
  return into.set(colourParser.fillStyle);
}
