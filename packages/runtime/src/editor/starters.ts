/**
 * The starter tables of the wizard's last step (#390), like PowerPoint's templates. Each one sets
 * the layers (one button each), the map's life at rest and the controller theme. Plain data with
 * no page code, so the tests can read it.
 */
export interface Starter {
  id: string;
  name: string;
  /** One line on what the table is about. */
  about: string;
  icon: string;
  /** Layer packages that become buttons, in order. */
  layers: string[];
  /** Map life at rest (ambient packages), besides the base map every table has. */
  rest: string[];
  /** A built-in controller theme id (packages/dashboard themes.ts). */
  theme: string;
}

export const STARTERS: Starter[] = [
  {
    id: 'climate',
    name: 'Climate',
    about: 'How the place feels outdoors: where the sun falls, where it is windy, the cool way through.',
    icon: 'sun',
    layers: ['sunlight', 'wind', 'coolpaths'],
    rest: ['trees'],
    theme: 'forest',
  },
  {
    id: 'movement',
    name: 'Movement',
    about: 'How people and vehicles move: traffic and public transport at rest, and a mobility layer.',
    icon: 'car',
    layers: ['mobility'],
    rest: ['cars', 'transit', 'street-life'],
    theme: 'midnight',
  },
  {
    id: 'story',
    name: 'Story',
    about: 'A slideshow of pictures, plans and maps for a guide to tell the place’s story.',
    icon: 'images',
    layers: ['slideshow'],
    rest: ['building-lights'],
    theme: 'paper',
  },
  {
    id: 'blank',
    name: 'Blank',
    about: 'Just the base map. Add layers from Insert in the editor.',
    icon: 'map',
    layers: [],
    rest: [],
    theme: 'midnight',
  },
];
