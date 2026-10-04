// On-screen keys that touch keyboards lack. Ctrl and Alt are sticky: tap once
// and they apply to the next key, whether it comes from this bar or the keyboard.
type Props = {
  ctrl: boolean;
  alt: boolean;
  setCtrl: (v: boolean) => void;
  setAlt: (v: boolean) => void;
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

export function KeyBar({ ctrl, alt, setCtrl, setAlt, send, onKeyboard }: Props) {
  const press = (seq: string) => {
    send(applyModifiers(seq, ctrl, alt));
    setCtrl(false);
    setAlt(false);
  };
  // preventDefault on mousedown keeps focus (and the soft keyboard) on the terminal.
  const keep = (e: React.MouseEvent | React.PointerEvent) => e.preventDefault();

  return (
    <div className="keybar" onMouseDown={keep}>
      <button className={`key mod ${ctrl ? 'on' : ''}`} onPointerDown={keep} onClick={() => setCtrl(!ctrl)}>
        ctrl
      </button>
      <button className={`key mod ${alt ? 'on' : ''}`} onPointerDown={keep} onClick={() => setAlt(!alt)}>
        alt
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

export function applyModifiers(data: string, ctrl: boolean, alt: boolean): string {
  let out = data;
  if (ctrl && out.length === 1) {
    const c = out.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
    else if (out === ' ') out = '\x00';
  }
  if (alt) out = '\x1b' + out;
  return out;
}
