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

/** "You are 3", in the phone's colour: the same number and colour the TV shows. */
export function phoneBadge(store: Store): HTMLElement {
  const badge = el('div', 'phone-badge');
  const dot = el('i');
  const label = el('span');
  badge.append(dot, label);
  const show = () => {
    const me = store.me();
    badge.hidden = !me;
    if (!me) return;
    dot.style.background = me.colour;
    dot.textContent = String(me.slot + 1);
    label.textContent = t('You are {n}', { n: me.slot + 1 });
  };
  show();
  store.onParticipants(show);
  return badge;
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
  } else if (reason.includes('joined again')) {
    door.append(el('h1', undefined, t('Open in another tab')), el('p', undefined, t('This phone is now controlling the table from another tab or window.')), retry(t('Use this one instead')));
  } else {
    door.append(el('h1', undefined, t('Could not join')), el('p', undefined, `${reason}.`), retry(t('Try again')));
  }
  return door;
}
