import { Fragment, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.tsx';
import type { Mention } from './mentions.ts';
import type { Attachment } from './attachments.tsx';

/** A chip in the box: a file the text names, or an attachment where it was put. */
export type Chip = Mention & { file?: Attachment };

// The composer's @mentions as chips, in the text where you wrote them. The text box stays a
// native textarea (dictation, autocorrect, selection); this layer lies exactly over it and
// draws its text, with each mention bordered, opened by a tap and removed by the × in its @. The box's
// own text turns transparent under it (styles.css `.has-mentions`), its caret and selection
// still showing. Only the chips take a tap; everything else falls through to the box.
//
// A chip drags to another place in the text: past a few pixels its copy follows the finger,
// a caret shows where it goes (found in this layer's text, which is the box's letter for
// letter), and letting go moves its text there (`onMove`).

/** How far a press moves before it's a drag, not a tap. */
const DRAG_START = 5;

type Drag = { chip: Chip; pointer: number; from: { x: number; y: number }; x: number; y: number; moving: boolean; to: number | null; caret: DOMRect | null; label: string };

/** The offset in the layer's text under a point, and where a caret there would be. */
function textAt(layer: HTMLElement, x: number, y: number): { offset: number; caret: DOMRect } | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) [node, offset] = [p.offsetNode, p.offset];
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) [node, offset] = [r.startContainer, r.startOffset];
  }
  if (!node || !layer.contains(node)) return null;
  const range = document.createRange();
  range.setStart(layer, 0);
  range.setEnd(node, offset);
  // The layer's last character is the zero-width one that keeps an empty last line.
  const length = range.toString().replace(/\u200b/g, '').length;
  range.setStart(node, offset);
  const rect = range.getBoundingClientRect();
  return { offset: length, caret: rect };
}

// What lays out text, copied from the box so every line wraps where its own does.
const TYPE = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariantLigatures', 'fontFeatureSettings', 'letterSpacing', 'wordSpacing', 'lineHeight', 'tabSize', 'textIndent', 'textTransform', 'wordBreak', 'overflowWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;

export function MentionLayer({ area, text, mentions, onOpen, onRemove, onMove }: { area: RefObject<HTMLTextAreaElement | null>; text: string; mentions: Chip[]; onOpen: (m: Chip) => void; onRemove: (m: Chip) => void; onMove: (m: Chip, to: number) => void }) {
  const layer = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // A drag ends in a click on the chip: that one doesn't open it.
  const dragged = useRef(false);

  function press(e: ReactPointerEvent<HTMLSpanElement>, chip: Chip) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragged.current = false;
    setDrag({ chip, pointer: e.pointerId, from: { x: e.clientX, y: e.clientY }, x: e.clientX, y: e.clientY, moving: false, to: null, caret: null, label: text.slice(chip.start, chip.end) });
  }
  function move(e: ReactPointerEvent<HTMLSpanElement>) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const moving = drag.moving || Math.hypot(e.clientX - drag.from.x, e.clientY - drag.from.y) > DRAG_START;
    if (!moving) return;
    e.preventDefault();
    const el = layer.current;
    // The layer takes the point for a moment, so it's its text (not the box) that's under it.
    el?.classList.add('dragging');
    const hit = el ? textAt(el, e.clientX, e.clientY) : null;
    setDrag({ ...drag, moving, x: e.clientX, y: e.clientY, to: hit?.offset ?? drag.to, caret: hit?.caret ?? drag.caret });
  }
  function release(e: ReactPointerEvent<HTMLSpanElement>) {
    if (!drag || e.pointerId !== drag.pointer) return;
    layer.current?.classList.remove('dragging');
    if (drag.moving) {
      dragged.current = true;
      if (drag.to !== null) onMove(drag.chip, drag.to);
    }
    setDrag(null);
  }
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
          className={`mention-chip ${m.file ? 'attached' : ''}`}
          role="button"
          aria-label={`Open ${m.file?.name ?? m.path}`}
          title={m.file?.name ?? m.path}
          // The box keeps focus (and a phone its keyboard) until the preview takes it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (dragged.current) dragged.current = false;
            else onOpen(m);
          }}
          onPointerDown={(e) => press(e, m)}
          onPointerMove={move}
          onPointerUp={release}
          onPointerCancel={release}
          data-dragging={drag?.moving && drag.chip.start === m.start ? '' : undefined}
        >
          {/* The × takes the @'s place: its width is all a chip can have without moving a letter. */}
          <span
            className="mention-x"
            role="button"
            aria-label={`Remove ${m.file?.name ?? m.path}`}
            onMouseDown={(e) => e.preventDefault()}
            // Its own press: the × takes the chip out, it doesn't drag it.
            onPointerDown={(e) => e.stopPropagation()}
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
      {/* On the page itself: a frosted bar above makes `fixed` its own, not the screen's. */}
      {drag?.moving && createPortal(
        <>
          {drag.caret && <span className="mention-drop" style={{ left: drag.caret.left, top: drag.caret.top, height: drag.caret.height || 20 }} />}
          <span className={`mention-chip mention-ghost ${drag.chip.file ? 'attached' : ''}`} style={{ left: drag.x, top: drag.y }} aria-hidden>
            {drag.label}
          </span>
        </>,
        document.body,
      )}
    </div>
  );
}
