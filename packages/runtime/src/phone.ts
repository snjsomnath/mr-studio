import type { Connection, Participant } from '@mrstudio/sdk';
import { ANIMALS, avatarOf, nameOf } from './avatars.ts';
import { t } from './i18n.ts';
import type { Store } from './store.ts';

const SEAT_KEY = 'mrstudio.seat';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The join code from the address the QR code opened. */
export function phoneCode(): string | undefined {
  return new URLSearchParams(location.search).get('c')?.trim() || undefined;
}

/** The resume token kept for this session code, if this phone joined it before. */
export function rememberedSeat(code: string): string | undefined {
  try {
    const seat = JSON.parse(localStorage.getItem(SEAT_KEY) ?? 'null');
    return seat?.code === code && typeof seat.token === 'string' ? seat.token : undefined;
  } catch {
    return undefined;
  }
}

export function rememberSeat(code: string, token: string): void {
  try {
    localStorage.setItem(SEAT_KEY, JSON.stringify({ code, token }));
  } catch {
    // Private browsing: a reload gets a new slot, nothing worse.
  }
}

/**
 * The phone's animal on its colour and its fun name, "Sunny Fox" (#339): the same animal and
 * colour the controller shows. A tap opens a sheet to change the name or pick another animal.
 */
export function phoneBadge(store: Store, connection: Connection): HTMLElement {
  const badge = el('button', 'phone-badge');
  badge.type = 'button';
  badge.setAttribute('aria-label', t('Change your name or animal'));
  const dot = el('i');
  const label = el('span');
  badge.append(dot, label);
  const show = () => {
    const me = store.me();
    badge.hidden = !me;
    if (!me) return;
    dot.style.background = me.colour;
    dot.textContent = avatarOf(me);
    label.textContent = nameOf(me);
  };
  show();
  store.onParticipants(show);
  badge.addEventListener('click', () => {
    const me = store.me();
    if (me) document.body.append(profileSheet(me, connection));
  });
  return badge;
}

/** Where a visitor names their phone and picks its animal. Changes go to the host as they are made. */
function profileSheet(me: Participant, connection: Connection): HTMLElement {
  const sheet = el('div', 'profile-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  const card = el('form', 'profile-card');
  const name = el('input');
  Object.assign(name, { value: me.name ?? '', maxLength: 32, placeholder: nameOf({ ...me, name: null }), autocomplete: 'off', enterKeyHint: 'done' });
  const animals = el('div', 'profile-animals');
  animals.setAttribute('role', 'radiogroup');
  animals.setAttribute('aria-label', t('Pick your animal'));
  for (const [id, animal] of Object.entries(ANIMALS)) {
    const pick = el('button', 'profile-animal', animal.emoji);
    pick.type = 'button';
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-label', t(animal.name));
    pick.setAttribute('aria-checked', String(id === me.avatar));
    pick.style.setProperty('--colour', me.colour);
    pick.addEventListener('click', () => {
      for (const other of animals.children) other.setAttribute('aria-checked', String(other === pick));
      void connection.request('participant.profile', { avatar: id }).catch(() => {});
    });
    animals.append(pick);
  }
  const close = () => {
    void connection.request('participant.profile', { name: name.value }).catch(() => {});
    sheet.remove();
  };
  card.addEventListener('submit', (event) => {
    event.preventDefault();
    close();
  });
  sheet.addEventListener('click', (event) => event.target === sheet && close());
  const done = el('button', 'action primary', t('Done'));
  done.type = 'submit';
  name.id = 'profile-name';
  const nameLabel = el('label', undefined, t('Your name'));
  nameLabel.htmlFor = name.id;
  card.append(nameLabel, name, el('p', 'profile-hint', t('Leave empty for a fun name')), el('p', 'profile-label', t('Pick your animal')), animals, done);
  sheet.append(card);
  return sheet;
}

/** What a phone shows instead of the controller when the host turned it away. */
export function refusedScreen(reason: string): HTMLElement {
  const door = el('div', 'door');
  const retry = (label: string) => {
    const button = el('button', 'action primary', label);
    button.type = 'button';
    button.addEventListener('click', () => location.reload());
    return button;
  };
  if (reason === 'session full') {
    door.append(el('h1', undefined, t('The table is full')), el('p', undefined, t('Every phone slot is taken. Try again when someone leaves.')), retry(t('Try again')));
  } else if (reason === 'wrong session code' || reason === 'no code') {
    const form = el('form');
    const input = el('input');
    Object.assign(input, { name: 'c', inputMode: 'numeric', autocomplete: 'off', maxLength: 8, required: true, ariaLabel: t('Session code') });
    const join = el('button', 'action primary', t('Join'));
    form.append(input, join);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      location.assign(`${location.pathname}?c=${encodeURIComponent(input.value.trim())}`);
    });
    const wrong = reason === 'wrong session code' && phoneCode() !== undefined;
    door.append(
      el('h1', undefined, wrong ? t('That code did not work') : t('Enter the session code')),
      el('p', undefined, wrong ? t('The session may have restarted. Scan the QR code on the TV again, or type the code it shows.') : t('It is shown on the TV next to the QR code.')),
      form,
    );
  } else if (reason.includes('ended this phone')) {
    // The operator let this phone go, or ended the round (#335).
    door.append(el('h1', undefined, t('Thanks for joining')), el('p', undefined, t('Your turn at the table has ended.')), retry(t('Join again')));
  } else if (reason.includes('joined again')) {
    door.append(el('h1', undefined, t('Open in another tab')), el('p', undefined, t('This phone is now controlling the table from another tab or window.')), retry(t('Use this one instead')));
  } else {
    door.append(el('h1', undefined, t('Could not join')), el('p', undefined, `${reason}.`), retry(t('Try again')));
  }
  return door;
}
