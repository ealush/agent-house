import { useEffect, useRef, type ButtonHTMLAttributes } from 'react';
import { registerConfirm } from './confirm.ts';
import { ConfirmKeys } from './shortcuts.tsx';

/**
 * A main confirmation button (Start, Terminate, Fork, Send…): it answers ⌘↵ /
 * Ctrl+↵ from anywhere in its dialog or screen, and shows that it does.
 */
export function ConfirmButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => (ref.current ? registerConfirm(ref.current) : undefined), []);
  return (
    <button ref={ref} {...props}>
      {children}
      <ConfirmKeys />
    </button>
  );
}
