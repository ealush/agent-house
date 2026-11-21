import { Fragment, useLayoutEffect, useRef, type RefObject } from 'react';
import { Icon } from './icons.tsx';
import type { Mention } from './mentions.ts';

// The composer's @mentions as chips, in the text where you wrote them. The text box stays a
// native textarea (dictation, autocorrect, selection); this layer lies exactly over it and
// draws its text, with each mention bordered, opened by a tap and removed by the × in its @. The box's
// own text turns transparent under it (styles.css `.has-mentions`), its caret and selection
// still showing. Only the chips take a tap; everything else falls through to the box.

// What lays out text, copied from the box so every line wraps where its own does.
const TYPE = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariantLigatures', 'fontFeatureSettings', 'letterSpacing', 'wordSpacing', 'lineHeight', 'tabSize', 'textIndent', 'textTransform', 'wordBreak', 'overflowWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;

export function MentionLayer({ area, text, mentions, onOpen, onRemove }: { area: RefObject<HTMLTextAreaElement | null>; text: string; mentions: Mention[]; onOpen: (m: Mention) => void; onRemove: (m: Mention) => void }) {
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = area.current;
    const el = layer.current;
    if (!box || !el) return;
    const fit = () => {
      const style = getComputedStyle(box);
      for (const k of TYPE) el.style[k] = style[k];
      // The box's text area: inside its border, without a scrollbar (clientWidth leaves it out).
      // From the rects, not offsetTop: those round, and half a pixel shows on every letter.
      const at = box.getBoundingClientRect();
      const parent = el.offsetParent?.getBoundingClientRect() ?? { top: 0, left: 0 };
      el.style.top = `${at.top - parent.top + box.clientTop}px`;
      el.style.left = `${at.left - parent.left + box.clientLeft}px`;
      el.style.width = `${box.clientWidth}px`;
      el.style.height = `${box.clientHeight}px`;
      el.scrollTop = box.scrollTop;
    };
    fit();
    const follow = () => (el.scrollTop = box.scrollTop);
    const resized = new ResizeObserver(fit);
    resized.observe(box);
    box.addEventListener('scroll', follow, { passive: true });
    return () => {
      resized.disconnect();
      box.removeEventListener('scroll', follow);
    };
  }, [area, text]);

  let at = 0;
  const parts = mentions.map((m) => {
    const before = text.slice(at, m.start);
    at = m.end;
    return (
      <Fragment key={m.start}>
        {before}
        <span
          className="mention-chip"
          role="button"
          aria-label={`Open ${m.path}`}
          title={m.path}
          // The box keeps focus (and a phone its keyboard) until the preview takes it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpen(m)}
        >
          {/* The × takes the @'s place: its width is all a chip can have without moving a letter. */}
          <span
            className="mention-x"
            role="button"
            aria-label={`Remove ${m.path}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(m);
            }}
          >
            @
            <Icon name="close" size={10} />
          </span>
          {text.slice(m.start + 1, m.end)}
        </span>
      </Fragment>
    );
  });
  return (
    <div ref={layer} className="mention-layer">
      {parts}
      {text.slice(at)}
      {/* A last empty line is a line too, as it is in the box. */}
      {'​'}
    </div>
  );
}
