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

const KEYS: Array<[label: string, seq: string, title?: string]> = [
  ['esc', '\x1b'],
  ['tab', '\t'],
  ['⇧tab', '\x1b[Z', 'Shift+Tab'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['^C', '\x03', 'Ctrl+C'],
  ['⏎', '\r', 'Enter'],
  ['/', '/'],
  ['|', '|'],
  ['~', '~'],
  ['-', '-'],
];

export function KeyBar({ ctrl, alt, shift, pasting, setCtrl, setAlt, setShift, send, onPaste, onKeyboard }: Props) {
  const press = (seq: string) => {
    send(applyModifiers(seq, ctrl, alt, shift));
    setCtrl(false);
    setAlt(false);
    setShift(false);
  };
  // preventDefault on mousedown keeps focus (and the soft keyboard) on the terminal.
  const keep = (e: React.MouseEvent | React.PointerEvent) => e.preventDefault();

  return (
    <div className="keybar" onMouseDown={keep}>
      <button className={`key mod ${ctrl ? 'on' : ''}`} aria-pressed={ctrl} title="Ctrl for the next key" onPointerDown={keep} onClick={() => setCtrl(!ctrl)}>
        ctrl
      </button>
      <button className={`key mod ${alt ? 'on' : ''}`} aria-pressed={alt} title="Alt for the next key" onPointerDown={keep} onClick={() => setAlt(!alt)}>
        alt
      </button>
      <button className={`key mod ${shift ? 'on' : ''}`} aria-pressed={shift} title="Shift for the next key" onPointerDown={keep} onClick={() => setShift(!shift)}>
        shift
      </button>
      <button className="key" title="Paste from clipboard" disabled={pasting} onPointerDown={keep} onClick={onPaste}>
        {pasting ? 'pasting…' : 'paste'}
      </button>
      {KEYS.map(([label, seq, title]) => (
        <button key={label} className="key" title={title} onPointerDown={keep} onClick={() => press(seq)}>
          {label}
        </button>
      ))}
      <button className="key" title="Show keyboard" onClick={onKeyboard}>
        ⌨
      </button>
    </div>
  );
}
