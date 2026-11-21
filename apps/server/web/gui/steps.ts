// "Hide steps": a reading preference for every GUI on this device. Tool calls and
// thinking fold to one line per run, so the conversation reads as the agent's prose.
import { useSyncExternalStore } from 'react';

const KEY = 'ah.steps';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'hidden';
  } catch {
    return false;
  }
}

let hidden = read();

export function setStepsHidden(next: boolean) {
  hidden = next;
  try {
    localStorage.setItem(KEY, next ? 'hidden' : 'shown');
  } catch {}
  for (const l of listeners) l();
}

export const toggleSteps = () => setStepsHidden(!hidden);

export function useStepsHidden(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => hidden,
  );
}
