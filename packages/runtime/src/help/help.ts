// The Help window (#271): every feature and step-by-step guides, opened from the Help tab of
// the editor's ribbon. Its content is help.json, built from docs/guide/, the core layers and
// CHANGELOG.md by scripts/build-help.mjs, so it matches the app it came with.
import './help.css';
import { icon } from '../editor/icons.ts';

interface Page {
  id: string;
  kind: 'guide' | 'features' | 'layer' | 'trouble' | 'release';
  title: string;
  summary: string;
  body: string;
}
interface Help {
  version: string;
  pictures: string;
  fallback: string;
  pages: Page[];
}

/** Where the editor asks the Help window to go: it writes the page id here before opening it. */
export const HELP_PAGE_KEY = 'mrstudio.help.page';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Bold, code, links and pictures inside a line. Never innerHTML. */
function inline(parent: HTMLElement, text: string, help: Help): HTMLElement {
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    parent.append(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[2]) parent.append(picture(m[2], m[1] ?? '', help));
    else if (m[4]) {
      const a = el('a', undefined, m[3]);
      if (/^https:\/\//.test(m[4])) {
        a.href = m[4];
        a.target = '_blank';
        a.rel = 'noreferrer';
      } else if (/^#[a-z0-9-]+$/.test(m[4])) a.href = m[4]; // another page of the Help (#291)
      parent.append(a);
    } else if (m[5]) parent.append(el('strong', undefined, m[5]));
    else if (m[6]) parent.append(el('code', undefined, m[6]));
    else if (m[7]) parent.append(el('em', undefined, m[7]));
  }
  parent.append(text.slice(last));
  return parent;
}

/** A picture from the repository, at the commit this app was built from; main if that is not published. */
function picture(src: string, alt: string, help: Help): HTMLElement {
  const figure = el('figure', 'hp-figure');
  const img = el('img');
  img.alt = alt;
  img.loading = 'lazy';
  const path = src.replace(/^\.?\//, '');
  img.src = /^https:\/\//.test(src) ? src : help.pictures + path;
  img.onerror = () => {
    if (!/^https:\/\//.test(src) && !img.src.startsWith(help.fallback)) img.src = help.fallback + path;
    else figure.replaceChildren(el('figcaption', 'hp-offline', `Picture: ${alt} (shown when this computer is online)`));
  };
  figure.append(img);
  if (alt) figure.append(el('figcaption', undefined, alt));
  return figure;
}

/** The Markdown the guides use: headings, paragraphs, numbered and plain lists, pictures. */
function render(markdown: string, help: Help): HTMLElement {
  const root = el('div', 'hp-body');
  let list: HTMLElement | null = null;
  let para: HTMLElement | null = null;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const item = /^(?:[-*]|(\d+)[.)])\s+(.*)$/.exec(line);
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line);
    if (!line) list = para = null;
    else if (heading) {
      list = para = null;
      inline(root.appendChild(el(`h${Math.min(4, heading[1]!.length + 1)}` as 'h2')), heading[2]!, help);
    } else if (image) {
      list = para = null;
      root.append(picture(image[2]!, image[1]!, help));
    } else if (item) {
      const tag = item[1] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) list = root.appendChild(el(tag));
      para = inline(list.appendChild(el('li')), item[2]!, help);
    } else if (para) inline(para, ` ${line}`, help);
    else {
      list = null;
      para = inline(root.appendChild(el('p')), line, help);
    }
  }
  return root;
}

export async function helpWindow(app: HTMLElement): Promise<void> {
  document.title = 'MR Studio Help';
  const help = (await fetch('/help.json').then((r) => r.json())) as Help;

  const shell = el('div', 'hp');
  const side = el('aside', 'hp-side');
  const brand = el('div', 'hp-brand');
  brand.append(icon('layers', 18), el('b', undefined, 'MR Studio Help'), el('span', undefined, `Version ${help.version}`));
  const search = el('input', 'hp-search');
  search.type = 'search';
  search.placeholder = 'Search the guide';
  search.ariaLabel = 'Search the guide';
  const nav = el('nav', 'hp-nav');
  const main = el('main', 'hp-main');
  side.append(brand, search, nav);
  shell.append(side, main);
  app.replaceChildren(shell);

  const groups: [string, Page['kind']][] = [
    ['Step by step', 'guide'],
    ['Everything on the table', 'features'],
    ['Layers one by one', 'layer'],
    ['When something is wrong', 'trouble'],
    ["What's new", 'release'],
  ];
  let current = '';

  function show(id: string): void {
    const p = help.pages.find((x) => x.id === id) ?? help.pages[0]!;
    current = p.id;
    if (location.hash !== `#${p.id}`) history.replaceState(null, '', `#${p.id}`);
    const header = el('header', 'hp-head');
    header.append(el('p', 'hp-kind', groups.find(([, k]) => k === p.kind)?.[0] ?? ''), el('h1', undefined, p.title));
    if (p.summary) header.append(el('p', 'hp-summary', p.summary));
    const article = el('article');
    article.append(header, render(p.body, help));
    // The next guide, so a reader can go through them in order.
    const guides = help.pages.filter((x) => x.kind === 'guide');
    const at = guides.findIndex((x) => x.id === p.id);
    if (at >= 0 && at < guides.length - 1) {
      const next = el('button', 'hp-next');
      next.type = 'button';
      next.append(el('span', undefined, 'Next guide'), el('b', undefined, guides[at + 1]!.title));
      next.onclick = () => show(guides[at + 1]!.id);
      article.append(next);
    }
    main.replaceChildren(article);
    main.scrollTop = 0;
    drawNav();
  }

  function drawNav(): void {
    const query = search.value.trim().toLowerCase();
    const matches = (p: Page) => !query || `${p.title} ${p.summary} ${p.body}`.toLowerCase().includes(query);
    nav.replaceChildren(
      ...groups.flatMap(([label, kind]) => {
        const pages = help.pages.filter((p) => p.kind === kind && matches(p));
        if (!pages.length) return [];
        const list = el('ul');
        for (const p of pages) {
          const b = el('button', p.id === current ? 'is-current' : undefined, p.title);
          b.type = 'button';
          b.title = p.summary;
          b.onclick = () => show(p.id);
          const li = el('li');
          li.append(b);
          list.append(li);
        }
        return [el('h2', undefined, label), list];
      }),
    );
    if (!nav.childElementCount) nav.append(el('p', 'hp-none', 'Nothing in the guide matches.'));
  }

  search.addEventListener('input', drawNav);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = nav.querySelector<HTMLButtonElement>('li button');
    first?.click();
  });
  // The editor asks for a page by writing its id; an open Help window follows.
  const asked = () => {
    try {
      const id = localStorage.getItem(HELP_PAGE_KEY);
      if (id) {
        localStorage.removeItem(HELP_PAGE_KEY);
        return id;
      }
    } catch {
      /* storage off */
    }
    return null;
  };
  window.addEventListener('storage', (e) => {
    if (e.key === HELP_PAGE_KEY && e.newValue) show(asked() ?? e.newValue);
  });
  window.addEventListener('focus', () => {
    const id = asked();
    if (id) show(id);
  });
  window.addEventListener('hashchange', () => location.hash.slice(1) !== current && show(location.hash.slice(1)));
  show(asked() ?? location.hash.slice(1));
}
