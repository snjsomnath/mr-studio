import qrcode from 'qrcode-generator';

import { t } from './i18n.ts';
import type { Store } from './store.ts';

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A QR code as an SVG: dark on white with the quiet zone scanners need. */
export function qrSvg(text: string): SVGSVGElement {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('QR code to join from a phone'));
  const background = document.createElementNS(NS, 'rect');
  background.setAttribute('width', String(size));
  background.setAttribute('height', String(size));
  background.setAttribute('fill', '#ffffff');
  const modules = document.createElementNS(NS, 'path');
  modules.setAttribute('d', path);
  modules.setAttribute('fill', '#000000');
  svg.append(background, modules);
  return svg;
}

/** How long a phone that lost its connection still shows as reconnecting. */
const AWAY_MS = 2 * 60 * 1000;

/**
 * The TV's invitation: the QR code for the session's join address, the address
 * and code to type instead, and who has joined, in their slot colours. Hidden
 * while phones cannot join.
 */

export function joinPanel(store: Store): HTMLElement {
  const panel = el('section', 'join');
  const text = el('div', 'join-text');
  const people = el('div', 'join-people');
  const count = el('p', 'join-count');

  const invite = () => {
    const { join_url: url, code } = store.state.session;
    panel.querySelector('.join-qr')?.remove();
    // Visitors only see an invitation they can use. Why phones cannot join is for the operator, in the editor.
    panel.hidden = !url;
    // The stylesheet lays the panel out as flex, which would show it anyway.
    panel.style.display = url ? '' : 'none';
    if (!url) {
      text.replaceChildren();
      return;
    }
    const qr = el('div', 'join-qr');
    qr.dataset.url = url;
    qr.append(qrSvg(url));
    panel.prepend(qr);
    const address = el('p', 'join-address');
    const where = new URL(url);
    // "or open <address> and enter <code>", with the address and the code in bold, in either language.
    const [before, middle, after] = t('or open {address} and enter {code}').split(/\{address\}|\{code\}/);
    address.append(before ?? '', el('b', '', `${where.host}${where.pathname}`), middle ?? '', el('b', 'join-code', code), after ?? '');
    text.replaceChildren(el('h2', '', t('Join from your phone')), el('p', '', t('Scan with your camera,')), address);
  };

  const away = new Map<number, number>();
  const show = () => {
    const participants = store.state.participants;
    // A phone that has been gone for a while is not shown; one that is reconnecting is, faded.
    const now = Date.now();
    for (const p of participants) if (p.connected) away.delete(p.slot);
    else if (!away.has(p.slot)) away.set(p.slot, now);
    const visible = participants.filter((p) => p.connected || now - (away.get(p.slot) ?? now) < AWAY_MS);
    people.replaceChildren(
      ...visible.map((p) => {
        const dot = el('span', 'join-person', String(p.slot + 1));
        dot.style.background = p.colour;
        dot.classList.toggle('is-away', !p.connected);
        dot.title = p.connected ? t('Phone {n}', { n: p.slot + 1 }) : t('Phone {n}, reconnecting', { n: p.slot + 1 });
        return dot;
      }),
    );
    const here = participants.filter((p) => p.connected).length;
    count.textContent = here === 1 ? t('1 phone') : t('{n} phones', { n: here });
  };

  panel.append(text);
  text.after(el('div', 'join-crowd'));
  panel.querySelector('.join-crowd')!.append(people, count);
  invite();
  show();
  setInterval(() => store.state.participants.some((p) => !p.connected) && show(), 30_000);
  // A reconnect can land in a new session (the host restarted), with a new code.
  let shown = store.state.session.join_url;
  store.onParticipants(() => {
    if (store.state.session.join_url !== shown) {
      shown = store.state.session.join_url;
      invite();
    }
    show();
  });
  return panel;
}
