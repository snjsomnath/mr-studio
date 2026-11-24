import { defineWidget } from '../registry.ts';
import { TEXT } from '../rules.ts';
import { h, setText } from './dom.ts';

/** A site file's address, or null for anything outside the site folder. */
export function mediaUrl(path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) return null;
  const clean = path.trim().replace(/^\.?\//, '');
  if (/^[a-z]+:|^\/|\.\.|\\/i.test(clean)) return null;
  return `/site/${clean.split('/').map(encodeURIComponent).join('/')}`;
}
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;

/** A picture or a video from the table's media (#356, the Media tab #306), optionally changing with a published value. */
export const media = defineWidget({
  type: 'media',
  name: 'Picture or video',
  description: 'A picture or a silent looping video from the table folder, which can change with a value a layer publishes.',
  sizes: ['tile', 'wide', 'tall', 'block', 'hero'],
  example: { path: '/site/media/street.jpg', caption: 'The street today' },
  props: {
    path: { kind: 'text', max: 200, label: 'File in the table folder (media/…)', required: true, bindable: true },
    fit: { kind: 'enum', options: ['cover', 'contain'], label: 'Fit', default: 'cover' },
    caption: { kind: 'text', max: TEXT.caption, label: 'Caption', bindable: true },
  },
  // A picture is one thing to look at; a caption is one more.
  reads: (props) => 1 + (props.caption !== undefined ? 1 : 0),
  mount(el) {
    const frame = h('div', 'mrs-media');
    const caption = h('p', 'mrs-caption mrs-media-caption');
    el.append(frame, caption);
    let shown = '';
    return {
      update(props) {
        const url = mediaUrl(props.path);
        if ((url ?? '') !== shown) {
          shown = url ?? '';
          frame.replaceChildren();
          if (url && VIDEO.test(url)) {
            const video = document.createElement('video');
            Object.assign(video, { src: url, muted: true, loop: true, autoplay: true, playsInline: true });
            frame.append(video);
          } else if (url) {
            const image = document.createElement('img');
            image.src = url;
            image.alt = props.caption ?? '';
            frame.append(image);
          }
        }
        frame.dataset.fit = props.fit ?? 'cover';
        setText(caption, props.caption ?? '');
        caption.hidden = !props.caption;
      },
    };
  },
});
