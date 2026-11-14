import qrcode from 'qrcode-generator';

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
  svg.setAttribute('aria-label', 'QR code to join from a phone');
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

/**
 * The TV's invitation: the QR code for the session's join address, the address
 * and code to type instead, and who has joined, in their slot colours.
 */
export function joinPanel(store: Store): HTMLElement {
  const panel = el('section', 'join');
  const text = el('div', 'join-text');
  const people = el('div', 'join-people');
  const count = el('p', 'join-count');

  const invite = () => {
    const { join_url: url, code } = store.state.session;
    panel.querySelector('.join-qr')?.remove();
    if (!url) {
      text.replaceChildren(el('h2', '', 'Phones cannot join yet'), el('p', '', 'This table is only reachable from this computer. In the MR Studio app, turn on “Let phones on this network join” in the settings. From the command line, start it with --lan.'));
      return;
    }
    const qr = el('div', 'join-qr');
    qr.dataset.url = url;
    qr.append(qrSvg(url));
    panel.prepend(qr);
    const address = el('p', 'join-address');
    const where = new URL(url);
    address.append('or open ', el('b', '', `${where.host}${where.pathname}`), ' and enter ', el('b', 'join-code', code));
    text.replaceChildren(el('h2', '', 'Join from your phone'), el('p', '', 'Scan with your camera,'), address);
  };

  const show = () => {
    const participants = store.state.participants;
    people.replaceChildren(
      ...participants.map((p) => {
        const dot = el('span', 'join-person', String(p.slot + 1));
        dot.style.background = p.colour;
        dot.classList.toggle('is-away', !p.connected);
        dot.title = p.connected ? `Phone ${p.slot + 1}` : `Phone ${p.slot + 1}, reconnecting`;
        return dot;
      }),
    );
    const here = participants.filter((p) => p.connected).length;
    count.textContent = here === 1 ? '1 phone' : `${here} phones`;
  };

  panel.append(text);
  text.after(el('div', 'join-crowd'));
  panel.querySelector('.join-crowd')!.append(people, count);
  invite();
  show();
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
