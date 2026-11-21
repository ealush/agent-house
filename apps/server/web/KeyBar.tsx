import { applyModifiers } from './keyboard.ts';

// On-screen keys that touch keyboards lack. Ctrl, Alt and Shift are sticky: tap once
// and they apply to the next key, whether it comes from this bar or the keyboard.
type Props = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  pasting: boolean;
  setCtrl: (v: boolean) => void;
  setAlt: (v: boolean) => void;
  setShift: (v: boolean) => void;
  onPaste: () => void;
  send: (data: string) => void;
  onKeyboard: () => void;
};

// What a terminal needs most comes first, in reach without scrolling the bar: esc, ctrl,
// tab and the arrows (the way through a shell's history and an agent's menus), and ^C.
const FIRST: Key[] = [
  ['esc', '\x1b'],
  'ctrl',
  ['tab', '\t'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['^C', '\x03', 'Ctrl+C'],
];
const THEN: Key[] = [
  'paste',
  'alt',
  'shift',
  ['⇧tab', '\x1b[Z', 'Shift+Tab'],
  ['⏎', '\r', 'Enter'],
  ['/', '/'],
  ['|', '|'],
  ['~', '~'],
  ['-', '-'],
];
type Key = 'ctrl' | 'alt' | 'shift' | 'paste' | [label: string, seq: string, title?: string];

export function KeyBar({ ctrl, alt, shift, pasting, setCtrl, setAlt, setShift, send, onPaste, onKeyboard }: Props) {
  const press = (seq: string) => {
    send(applyModifiers(seq, ctrl, alt, shift));
    setCtrl(false);
    setAlt(false);
    setShift(false);
  };
  const mods = { ctrl: [ctrl, setCtrl], alt: [alt, setAlt], shift: [shift, setShift] } as const;
  // preventDefault on mousedown keeps focus (and the soft keyboard) on the terminal.
  const keep = (e: React.MouseEvent | React.PointerEvent) => e.preventDefault();

  return (
    <div className="keybar" onMouseDown={keep}>
      {[...FIRST, ...THEN].map((k) => {
        if (k === 'paste')
          return (
            <button key={k} className="key" title="Paste from clipboard" disabled={pasting} onPointerDown={keep} onClick={onPaste}>
              {pasting ? 'pasting…' : 'paste'}
            </button>
          );
        if (typeof k === 'string') {
          const [on, set] = mods[k];
          return (
            <button key={k} className={`key mod ${on ? 'on' : ''}`} aria-pressed={on} title={`${k[0].toUpperCase()}${k.slice(1)} for the next key`} onPointerDown={keep} onClick={() => set(!on)}>
              {k}
            </button>
          );
        }
        const [label, seq, title] = k;
        return (
          <button key={label} className="key" title={title} onPointerDown={keep} onClick={() => press(seq)}>
            {label}
          </button>
        );
      })}
      <button className="key" title="Show keyboard" onClick={onKeyboard}>
        ⌨
      </button>
    </div>
  );
}
