// Phones' animals and fun names (#339): every phone that joins is "Sunny Fox" or "Brave Owl",
// on its colour, until the visitor gives it a name of their own.
import type { Participant } from '@mrstudio/sdk';
import { t } from './i18n.ts';

/** The host's animals (AVATARS in hub.rs), each with its picture and its name. */
export const ANIMALS: Record<string, { emoji: string; name: string }> = {
  fox: { emoji: '🦊', name: 'Fox' },
  octopus: { emoji: '🐙', name: 'Octopus' },
  owl: { emoji: '🦉', name: 'Owl' },
  frog: { emoji: '🐸', name: 'Frog' },
  turtle: { emoji: '🐢', name: 'Turtle' },
  penguin: { emoji: '🐧', name: 'Penguin' },
  butterfly: { emoji: '🦋', name: 'Butterfly' },
  unicorn: { emoji: '🦄', name: 'Unicorn' },
  otter: { emoji: '🦦', name: 'Otter' },
  hedgehog: { emoji: '🦔', name: 'Hedgehog' },
  whale: { emoji: '🐳', name: 'Whale' },
  bee: { emoji: '🐝', name: 'Bee' },
};

/** The host's moods (MOODS in hub.rs). */
const MOODS: Record<string, string> = {
  curious: 'Curious',
  cosmic: 'Cosmic',
  sunny: 'Sunny',
  merry: 'Merry',
  brave: 'Brave',
  gentle: 'Gentle',
  lucky: 'Lucky',
  swift: 'Swift',
};

type Who = Pick<Participant, 'slot'> & Partial<Pick<Participant, 'avatar' | 'mood' | 'name'>>;

/** The phone's picture: its animal, or its number for a host that gives none. */
export function avatarOf(p: Who): string {
  return (p.avatar && ANIMALS[p.avatar]?.emoji) || String(p.slot + 1);
}

/** What to call the phone: the visitor's own name, else the fun name in the visitor's language. */
export function nameOf(p: Who): string {
  if (p.name) return p.name;
  const animal = p.avatar && ANIMALS[p.avatar];
  const mood = p.mood && MOODS[p.mood];
  if (!animal) return t('Phone {n}', { n: p.slot + 1 });
  return mood ? `${t(mood)} ${t(animal.name)}` : t(animal.name);
}
