import qrcode from 'qrcode-generator';

import type { Connection } from '@mrstudio/sdk';

import { t } from './i18n.ts';
import { avatarOf, nameOf } from './avatars.ts';
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
        // Each phone's animal on its colour (#339), its name on hover.
        const dot = el('span', 'join-person', avatarOf(p));
        dot.style.background = p.colour;
        dot.classList.toggle('is-away', !p.connected);
        dot.title = p.connected ? nameOf(p) : t('{who}, reconnecting', { who: nameOf(p) });
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

/**
 * Looking after the phones (#335), on the operator's Developer window: pause them, let one go,
 * end the round (every phone goes and every sketch is cleared), and download what they did.
 */
export function phonesPanel(store: Store, connection: Connection): HTMLElement {
  const panel = el('section', 'phones-panel');
  panel.append(el('h2', '', t('Phones')));
  const pause = el('label', 'phones-pause');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'switch';
  // While the host has not answered, a participants update still carries the old state, so it must not flip the switch back.
  let asking = 0;
  box.addEventListener('change', () => {
    asking++;
    void connection
      .request('phones.pause', { paused: box.checked })
      .catch(() => (box.checked = !box.checked))
      .finally(() => asking--);
  });
  pause.append(box, el('span', '', t('Pause the phones')));
  const list = el('ul', 'phones-list');
  const tools = el('div', 'phones-tools');
  const end = el('button', 'action', t('End the round')) as HTMLButtonElement;
  end.type = 'button';
  // Ending a round is pressed twice, so a slip does not send everyone away.
  let armed = 0;
  end.addEventListener('click', () => {
    if (!armed) {
      end.textContent = t('Press again to end the round');
      armed = window.setTimeout(() => {
        armed = 0;
        end.textContent = t('End the round');
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    end.textContent = t('End the round');
    void connection.request('phones.release', {}).catch(() => {});
    for (const id of store.state.scene) {
      if (store.state.layers[id]?.layer === 'sketch' && store.state.layers[id]?.active) void connection.request('layer.action', { layer: id, action: 'clear' }).catch(() => {});
    }
  });
  const log = el('button', 'action', t('Download the session log')) as HTMLButtonElement;
  log.type = 'button';
  log.addEventListener('click', async () => {
    const answer = await connection.request<{ log: unknown[] }>('phones.log').catch(() => ({ log: [] }));
    const file = new Blob([JSON.stringify({ session: store.state.session.id, site: store.state.site.name, log: answer.log }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = `phones-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  tools.append(end, log);
  const show = () => {
    if (asking === 0) box.checked = store.state.session.phones_paused === true;
    const here = store.state.participants;
    list.replaceChildren(
      ...here.map((p) => {
        const row = el('li', p.connected ? '' : 'is-away');
        const dot = el('span', 'join-person', avatarOf(p));
        dot.style.background = p.colour;
        const go = el('button', 'action', t('Let go')) as HTMLButtonElement;
        go.type = 'button';
        go.setAttribute('aria-label', t('Let {who} go', { who: nameOf(p) }));
        go.addEventListener('click', () => void connection.request('phones.release', { slot: p.slot }).catch(() => {}));
        row.append(dot, el('span', '', nameOf(p)), go);
        return row;
      }),
    );
    if (here.length === 0) list.append(el('li', 'phones-none', t('No phones have joined.')));
  };
  show();
  store.onParticipants(show);
  panel.append(pause, list, tools);
  return panel;
}

/**
 * A line across the top of a phone that joined a full table (#462). It looks around, and when a
 * seat frees up (fewer phones in the session) it joins again to take it.
 */
export function watchingBanner(store: Store): HTMLElement {
  const banner = el('p', 'phones-watching', t('Every seat at the table is taken. You can look around, and you get a seat when one frees up.'));
  banner.setAttribute('role', 'status');
  banner.hidden = !store.watching;
  let seated = store.state.participants.length;
  store.onParticipants((participants) => {
    if (store.watching && participants.length < seated) location.reload();
    seated = participants.length;
  });
  return banner;
}

/** A line across the top of a phone while the operator has paused the phones (#335). */
export function pausedBanner(store: Store): HTMLElement {
  const banner = el('p', 'phones-paused', t('The table is paused for a moment. You can look around; changes wait until it goes on.'));
  banner.setAttribute('role', 'status');
  const show = () => (banner.hidden = store.state.session.phones_paused !== true);
  show();
  store.onParticipants(show);
  return banner;
}
