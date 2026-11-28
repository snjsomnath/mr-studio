// Swedish and English for visitors (#80). The visitors' screens (the controller, the phones and
// the table's ribbons) speak the session's language; the editor stays in English.
//
// Every visitor-facing text is written in English and looked up by that English text:
// a layer's words in its package (`locales/sv.json`, sent as `manifest.locales.sv`), the site's
// words in `branding.translations.sv`, and the runtime's own words below. What is not found
// stays in English, so a half-translated table still reads.

import { setNumberLanguage } from '@mrstudio/sdk';
import type { Control, LayerManifest, SessionState } from '@mrstudio/sdk';

import type { Store } from './store.ts';

export type Language = 'en' | 'sv';

/** The languages the runtime speaks, with the name each goes by in itself. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', sv: 'Svenska' };

/** The runtime's own words in Swedish: the controller, the phones and the ribbons. */
const SV: Record<string, string> = {
  // Controller
  'Choose a layer to bring it to the table.': 'Välj ett lager för att visa det på bordet.',
  'Previous step': 'Föregående steg',
  'Next step': 'Nästa steg',
  'Play the steps': 'Spela upp stegen',
  'Pause the steps': 'Pausa stegen',
  '{n} of {count}': '{n} av {count}',
  '{n} of {count} shown': '{n} av {count} visas',
  'Legend': 'Teckenförklaring',
  'Sounds': 'Ljud',
  'Playing': 'Spelas',
  'Tap to play': 'Tryck för att spela',
  'More settings': 'Fler inställningar',
  'Item': 'Objekt',
  'Tap one on the table, or choose it from the list.': 'Tryck på ett på bordet, eller välj i listan.',
  'Layers': 'Lager',
  'No layers are recorded here.': 'Inga lager finns registrerade här.',
  'Bottom at {depth}': 'Botten på {depth}',
  'Choose a {thing}': 'Välj {thing}',
  'Choose…': 'Välj …',
  'Back to default': 'Tillbaka till standard',
  'Apply to all of {group}': 'Gäller alla i {group}',
  '{count} changed': '{count} ändrade',
  'Reset': 'Börja om',
  'Reset view': 'Återställ vyn',
  'Full screen': 'Helskärm',
  'Calibrate': 'Kalibrera',
  'Sound': 'Ljud',
  'Muted': 'Ljud av',
  'Recording': 'Spelar in',
  'Recorded session, read only': 'Inspelad session, kan inte ändras',
  'Just watch': 'Bara titta',
  'This session is being recorded': 'Det här passet spelas in',
  'The organisers record this session to look at it again afterwards.': 'Arrangörerna spelar in passet för att kunna titta på det igen efteråt.',
  'What is kept: what you draw, vote and write, and your photos and sounds, under your animal name. Nothing about your phone itself.':
    'Det som sparas: det du ritar, röstar och skriver, och dina foton och ljud, under ditt djurnamn. Inget om själva telefonen.',
  'Just watch: look around without a seat. Nothing from this phone is kept.': 'Bara titta: titta runt utan plats. Inget från den här telefonen sparas.',
  'You are watching. Nothing from this phone is recorded.': 'Du tittar. Inget från den här telefonen spelas in.',
  'Ribbon': 'Remsa',
  'Auto': 'Auto',
  'Ribbon: {name}': 'Remsa: {name}',
  'Map controls': 'Kartan',
  'About': 'Om',
  'Credits': 'Medverkande',
  'Source: {source}': 'Källa: {source}',
  'Maps and data: {credits}': 'Kartor och data: {credits}',
  'Turn {name} on or off': 'Slå på eller av {name}',
  'Show the controls of {name}': 'Visa inställningarna för {name}',
  'Close {name}': 'Stäng {name}',
  '{name} turned on from a phone': '{name} slogs på från en mobil',
  '{name} turned off from a phone': '{name} slogs av från en mobil',
  'Another {thing}': 'En annan {thing}',
  'Turn a layer on to see it here': 'Slå på ett lager för att se det här',
  'Language': 'Språk',
  'On': 'På',
  'Off': 'Av',
  // Joining
  'Join from your phone': 'Var med från din mobil',
  'Scan with your camera,': 'Skanna med kameran,',
  'or open {address} and enter {code}': 'eller öppna {address} och skriv {code}',
  'QR code to join from a phone': 'QR-kod för att vara med från mobilen',
  '1 phone': '1 mobil',
  '{n} phones': '{n} mobiler',
  'Phone {n}': 'Mobil {n}',
  'Phone {n}, reconnecting': 'Mobil {n}, ansluter igen',
  '{who}, reconnecting': '{who}, ansluter igen',
  // Phones
  'You are {n}': 'Du är {n}',
  // Phones' animals and fun names (#339)
  'Fox': 'Räv', 'Octopus': 'Bläckfisk', 'Owl': 'Uggla', 'Frog': 'Groda', 'Turtle': 'Sköldpadda', 'Penguin': 'Pingvin',
  'Butterfly': 'Fjäril', 'Unicorn': 'Enhörning', 'Otter': 'Utter', 'Hedgehog': 'Igelkott', 'Whale': 'Val', 'Bee': 'Humla',
  'Curious': 'Nyfiken', 'Cosmic': 'Kosmisk', 'Sunny': 'Solig', 'Merry': 'Glad', 'Brave': 'Modig', 'Gentle': 'Snäll', 'Lucky': 'Lycklig', 'Swift': 'Snabb',
  'Your name': 'Ditt namn',
  'Pick your animal': 'Välj ditt djur',
  'Change your name or animal': 'Byt namn eller djur',
  'Done': 'Klar',
  'Leave empty for a fun name': 'Lämna tomt för ett roligt namn',
  '{who} turned on {name}': '{who} slog på {name}',
  '{who} turned off {name}': '{who} slog av {name}',
  'The table is full': 'Bordet är fullt',
  'Every phone slot is taken. Try again when someone leaves.': 'Alla platser är upptagna. Försök igen när någon går.',
  'Try again': 'Försök igen',
  'Session code': 'Sessionskod',
  'Join': 'Gå med',
  'That code did not work': 'Koden fungerade inte',
  'Enter the session code': 'Skriv sessionskoden',
  'The session may have restarted. Scan the QR code on the TV again, or type the code it shows.':
    'Sessionen kan ha startat om. Skanna QR-koden på skärmen igen, eller skriv koden som visas där.',
  'It is shown on the TV next to the QR code.': 'Den visas på skärmen bredvid QR-koden.',
  'Open in another tab': 'Öppen i en annan flik',
  'This phone is now controlling the table from another tab or window.': 'Den här mobilen styr nu bordet från en annan flik eller ett annat fönster.',
  'Use this one instead': 'Använd den här i stället',
  'Could not join': 'Kunde inte gå med',
  'Reconnecting…': 'Ansluter igen…',
  'Not available right now': 'Inte tillgängligt just nu',
  'Not available right now. It is starting again by itself.': 'Inte tillgängligt just nu. Det startar om av sig självt.',
  'Map of the table': 'Karta över bordet',
  'Undo': 'Ångra',
  'Clear': 'Rensa',
  'Send': 'Skicka',
  'Send point': 'Skicka punkten',
  'Send line': 'Skicka linjen',
  'Send area': 'Skicka området',
  'Point': 'Punkt',
  'Line': 'Linje',
  'Area': 'Område',
  'Tool': 'Verktyg',
  'Tap or drag on the map. Two fingers move the map.': 'Tryck eller dra på kartan. Två fingrar flyttar kartan.',
  'Tap to add points along the line, then send. Two fingers move the map.': 'Tryck för att lägga till punkter längs linjen och skicka sedan. Två fingrar flyttar kartan.',
  'Tap the corners of the area, then send. Two fingers move the map.': 'Tryck på områdets hörn och skicka sedan. Två fingrar flyttar kartan.',
  'Draw with one finger; it goes to the table when you lift it. Two fingers move the map.': 'Rita med ett finger; det skickas till bordet när du lyfter det. Två fingrar flyttar kartan.',
  'Open the table to see live values here.': 'Öppna bordet för att se levande värden här.',
  // A phone's layers and map (#335)
  'Open {name}': 'Öppna {name}',
  'Back to all layers': 'Tillbaka till alla lager',
  'Controls': 'Inställningar',
  'Map': 'Karta',
  'Turn it on to see it on the table and use it here.': 'Slå på det för att se det på bordet och använda det här.',
  'This layer is turned on from the controller.': 'Det här lagret slås på från kontrollskärmen.',
  'Fit table': 'Hela bordet',
  'Full screen map': 'Karta i helskärm',
  'Close the full screen map': 'Stäng helskärmskartan',
  'A few words': 'Några ord',
  'Every seat at the table is taken. You can look around, and you get a seat when one frees up.': 'Alla platser vid bordet är tagna. Du kan titta runt, och du får en plats när någon blir ledig.',
  'The table is paused for a moment. You can look around; changes wait until it goes on.': 'Bordet är pausat en stund. Du kan titta runt; ändringar får vänta tills det fortsätter.',
  'Thanks for joining': 'Tack för att du var med',
  'Your turn at the table has ended.': 'Din tur vid bordet är slut.',
  'Join again': 'Gå med igen',
  // Looking after the phones (#335)
  'Phones': 'Mobiler',
  'Pause the phones': 'Pausa mobilerna',
  'End the round': 'Avsluta omgången',
  'Press again to end the round': 'Tryck igen för att avsluta omgången',
  'Download the session log': 'Ladda ner sessionsloggen',
  'Let go': 'Släpp',
  'Let {who} go': 'Släpp {who}',
  'No phones have joined.': 'Inga mobiler har anslutit.',
  'Sent to the table.': 'Skickat till bordet.',
  'Not sent: {reason}.': 'Inte skickat: {reason}.',
  // Field walk on a phone (#445)
  'Field walk': 'Fältpromenad',
  'Walk around and mark what you notice, with a photo or a sound.': 'Gå runt och markera det du lägger märke till, med ett foto eller ett ljud.',
  'Walk around and mark what you notice, with a photo.': 'Gå runt och markera det du lägger märke till, med ett foto.',
  'Walk around and mark what you notice, with a sound.': 'Gå runt och markera det du lägger märke till, med ett ljud.',
  'Walk around and mark what you notice on the map.': 'Gå runt och markera det du lägger märke till på kartan.',
  'Mark a spot': 'Markera en plats',
  'Spot': 'Plats',
  'What is it?': 'Vad är det?',
  'How do you like this spot?': 'Vad tycker du om platsen?',
  'Don’t like it': 'Gillar inte',
  'Not much': 'Inte så mycket',
  'It’s OK': 'Okej',
  'Like it': 'Gillar',
  'Love it': 'Älskar',
  'Your spots show on the table as soon as it can be reached.': 'Dina platser syns på bordet så snart det går att nå.',
  '{n} spots on the table.': '{n} platser på bordet.',
  '{sent} on the table, {waiting} sending…': '{sent} på bordet, {waiting} skickas…',
  '{sent} on the table, {waiting} waiting until the table can be reached. Keep this page open.': '{sent} på bordet, {waiting} väntar tills bordet går att nå. Låt sidan vara öppen.',
  'Photo': 'Foto',
  'On the table': 'På bordet',
  'Not taken: {reason}': 'Togs inte emot: {reason}',
  'Sending {p}%': 'Skickar {p} %',
  'Waiting to send': 'Väntar på att skickas',
  'Delete this spot': 'Ta bort platsen',
  'The table can’t be reached. Try again when it can.': 'Bordet går inte att nå. Försök igen när det går.',
  'Finding you… or tap where you are on the map.': 'Letar efter dig… eller tryck där du är på kartan.',
  'Tap where you are on the map.': 'Tryck där du är på kartan.',
  'You are outside the table’s map. Walk closer, or tap where the spot is.': 'Du är utanför bordets karta. Gå närmare, eller tryck där platsen är.',
  'Placed by hand. Tap again to move it.': 'Utsatt för hand. Tryck igen för att flytta den.',
  'GPS is rough here (within {m} m). Tap the map to place the spot exactly.': 'GPS är osäker här (inom {m} m). Tryck på kartan för att sätta ut platsen exakt.',
  'Found by GPS, within {m} m. Tap the map if it is wrong.': 'Hittad med GPS, inom {m} m. Tryck på kartan om den är fel.',
  'GPS is not allowed. Tap where you are on the map.': 'GPS är inte tillåten. Tryck där du är på kartan.',
  'Getting the photo ready…': 'Gör i ordning fotot…',
  'That photo could not be read. Try again.': 'Fotot gick inte att läsa. Försök igen.',
  'Recording. Tap Stop when done.': 'Spelar in. Tryck Stopp när du är klar.',
  'Stop': 'Stopp',
  'Record again': 'Spela in igen',
  'The microphone is not allowed. Pick a recording instead.': 'Mikrofonen är inte tillåten. Välj en inspelning i stället.',
  'A few words (optional)': 'Några ord (valfritt)',
  'Cancel': 'Avbryt',
  'Save spot': 'Spara platsen',
};

const RUNTIME: Partial<Record<Language, Record<string, string>>> = { sv: SV };

let current: Language = 'en';
let site: Record<string, string> = {};

/** The language the visitors' screens speak now. */
export function language(): Language {
  return current;
}

function fill(text: string, vars?: Record<string, string | number>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (all, key: string) => (key in vars ? String(vars[key]) : all)) : text;
}

/** The runtime's own words and the site's, in the current language: `t('You are {n}', { n: 2 })`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  if (current === 'en') return fill(text, vars);
  return fill(site[text] ?? RUNTIME[current]?.[text] ?? text, vars);
}

/** A layer's words (its legend, its step titles, its panels), then the site's, then the runtime's. */
export function say(text: string, manifest?: LayerManifest, vars?: Record<string, string | number>): string {
  if (current === 'en' || !text) return fill(text, vars);
  return fill(manifest?.locales?.[current]?.[text] ?? site[text] ?? RUNTIME[current]?.[text] ?? text, vars);
}

/** The languages a table offers visitors: two or more show a switch. */
export function offered(state: SessionState): Language[] {
  const known = (state.site.branding.languages ?? []).filter((l): l is Language => l in LANGUAGE_NAMES);
  return known.length > 0 ? known : ['en'];
}

/** A panel's own words (a caption, the ends of a colour key); values bound to the layer are said as they are read. */
function sayProps(props: Record<string, unknown>, manifest: LayerManifest): Record<string, unknown> {
  const out = { ...props };
  for (const key of ['caption', 'low', 'high', 'label']) if (typeof out[key] === 'string') out[key] = say(out[key] as string, manifest);
  return out;
}

/** A layer's manifest in the current language: its name, description, controls, tools, legend and panels. */
function translated(manifest: LayerManifest): LayerManifest {
  const s = (text: string | undefined) => (text === undefined ? text : say(text, manifest));
  const control = (c: Control): Control => {
    const out = { ...c, label: s(c.label)! } as Control;
    if ('help' in c && typeof c.help === 'string') (out as { help?: string }).help = s(c.help);
    if (c.type === 'select') (out as typeof c).options = c.options.map((o) => ({ ...o, label: s(o.label)! }));
    if (c.type === 'date' && c.presets) (out as typeof c).presets = c.presets.map((p) => ({ ...p, label: s(p.label)! }));
    return out;
  };
  return {
    ...manifest,
    name: s(manifest.name)!,
    description: s(manifest.description),
    controls: manifest.controls?.map(control),
    tools: manifest.tools?.map((tool) => ({ ...tool, label: s(tool.label) })),
    // The legend stays in English here: its rows are matched to the steps' titles by their words.
    // The controller says them in the visitors' language as it draws them.
    panels: manifest.panels?.map((panel) => ({ ...panel, title: s(panel.title), props: panel.props && sayProps(panel.props, manifest) })),
  };
}

/**
 * Sets the visitors' language for this screen. The store then hands out manifests in it
 * (`store.manifest()`); the editor reads `store.manifests` and stays in English.
 */
export function speak(store: Store, language: Language): void {
  setLanguage(language);
  site = language === 'en' ? {} : (store.state.site.branding.translations?.[language] ?? {});
  store.useTranslation(language === 'en' ? null : translated);
  // What draws once and stays (the table's ribbons) draws again.
  window.dispatchEvent(new Event('mrs-language'));
}

/** Sets the language before there is a session to read words from: a phone turned away at the door. */
export function setLanguage(language: Language): void {
  current = language;
  document.documentElement.lang = language;
  // Numbers follow (#397): a decimal comma in Swedish.
  setNumberLanguage(language);
}

/** The language a phone's browser asks for, when MR Studio speaks it. */
export function browserLanguage(): Language {
  return (navigator.languages ?? [navigator.language]).some((l) => l?.toLowerCase().startsWith('sv')) ? 'sv' : 'en';
}

/** What this phone chose for itself, if anything. */
export function ownLanguage(): Language | null {
  try {
    const own = localStorage.getItem('mrs-language');
    return own && own in LANGUAGE_NAMES ? (own as Language) : null;
  } catch {
    return null;
  }
}

export function keepOwnLanguage(language: Language | null): void {
  try {
    if (language) localStorage.setItem('mrs-language', language);
    else localStorage.removeItem('mrs-language');
  } catch {
    // A private window: the choice lasts until the page reloads.
  }
}
