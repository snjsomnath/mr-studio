// Release notes are Markdown written on GitHub. This turns the parts release notes use
// (headings, lists, paragraphs, bold, italic, code, links, pictures) into DOM nodes.
// It never sets innerHTML, so nothing in a release description can run as markup.
window.renderMarkdown = (() => {
  const INLINE = /(!\[([^\]]*)\]\(([^)\s]+)[^)]*\))|(<img\b[^>]*>)|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*)\*)|(https:\/\/[^\s<)]+)/g;
  const safe = (url) => (/^https:\/\//i.test(url) ? url : null);

  function image(src, alt) {
    const url = safe(src);
    if (!url) return document.createTextNode(alt || '');
    return Object.assign(document.createElement('img'), { src: url, alt: alt || '', loading: 'lazy' });
  }

  function link(url, text) {
    const href = safe(url);
    if (!href) return document.createTextNode(text);
    const a = Object.assign(document.createElement('a'), { textContent: text, title: href });
    a.addEventListener('click', () => window.__TAURI__.core.invoke('open_link', { url: href }));
    return a;
  }

  function inline(parent, text) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      parent.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) parent.append(image(m[3], m[2]));
      else if (m[4]) parent.append(image(/src\s*=\s*["']([^"']+)["']/i.exec(m[4])?.[1] ?? '', /alt\s*=\s*["']([^"']*)["']/i.exec(m[4])?.[1]));
      else if (m[5]) parent.append(link(m[7], m[6]));
      else if (m[8]) parent.append(Object.assign(document.createElement('code'), { textContent: m[9] }));
      else if (m[10]) parent.append(Object.assign(document.createElement('strong'), { textContent: m[11] }));
      else if (m[12]) parent.append(Object.assign(document.createElement('em'), { textContent: m[13] }));
      else if (m[14]) parent.append(link(m[14], m[14]));
    }
    parent.append(text.slice(last));
    return parent;
  }

  return (markdown) => {
    const root = Object.assign(document.createElement('div'), { className: 'md' });
    let list = null;
    let paragraph = null;
    let code = null;
    // Comments are notes to whoever writes the release, not to the reader.
    for (const raw of markdown.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
      if (raw.trim().startsWith('```')) {
        code = code ? null : root.appendChild(document.createElement('pre'));
        list = paragraph = null;
        continue;
      }
      if (code) {
        code.append(`${raw}\n`);
        continue;
      }
      const line = raw.trim();
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const item = /^(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (!line) {
        list = paragraph = null;
      } else if (heading) {
        list = paragraph = null;
        inline(root.appendChild(document.createElement(`h${Math.min(4, heading[1].length + 1)}`)), heading[2]);
      } else if (item) {
        const tag = item[1] ? 'OL' : 'UL';
        if (!list || list.tagName !== tag) list = root.appendChild(document.createElement(tag));
        paragraph = inline(list.appendChild(document.createElement('li')), item[2]);
      } else if (paragraph) {
        // A wrapped line continues the paragraph or list item above it.
        inline(paragraph, ` ${line}`);
      } else {
        list = null;
        paragraph = inline(root.appendChild(document.createElement('p')), line);
      }
    }
    return root;
  };
})();
