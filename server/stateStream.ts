// The state stream (/api/events): every subscriber gets the whole state once, then only
// what changed, pass by pass. The decision of what changed is diffState(), a pure
// function of the last pass's fingerprints and this pass's state; StateStream holds the
// fingerprints and the subscribers.
//
// Frames (the wire contract, consumed by the web client and ah-native):
//   full:  the whole state, as JSON (sent once, at subscribe)
//   patch: every top-level field that changed, as JSON
//   slim:  the patch with `windows` replaced by `windowsDelta: { changed, order }` (the
//          windows that changed, and every window's uid in order), for ?delta=1 streams

/** What the last pass looked like, field by field and window by window, as JSON. */
export type Fingerprints = { readonly fields: ReadonlyMap<string, string>; readonly windows: ReadonlyMap<string, string> };

export const NO_FINGERPRINTS: Fingerprints = { fields: new Map(), windows: new Map() };

export type Frames = { full: string; patch: string; slim: string };

type Stateful = { windows: Array<{ uid: string }> } & Record<string, unknown>;

/** What this pass changed: the next fingerprints, and the frames to send (null: nothing changed). */
export function diffState(prev: Fingerprints, state: Stateful): { next: Fingerprints; frames: Frames | null } {
  // History and the preset catalogs are most of the state and rarely change, while
  // windows change every pass something is working: only changed fields go out.
  const fields = new Map(prev.fields);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    const part = JSON.stringify(v);
    if (fields.get(k) !== part) {
      fields.set(k, part);
      patch[k] = v;
    }
  }
  const windows = new Map<string, string>();
  const changed = state.windows.filter((w) => {
    const part = JSON.stringify(w);
    windows.set(w.uid, part);
    return prev.windows.get(w.uid) !== part;
  });
  const next = { fields, windows };
  if (!Object.keys(patch).length) return { next, frames: null };
  const delta = JSON.stringify(patch);
  const slim = 'windows' in patch ? JSON.stringify({ ...patch, windows: undefined, windowsDelta: { changed, order: state.windows.map((w) => w.uid) } }) : delta;
  return { next, frames: { full: JSON.stringify(state), patch: delta, slim } };
}

export type Listener = (full: string, patch: string | null, slim: string | null) => void;

export class StateStream {
  private fingerprints: Fingerprints = NO_FINGERPRINTS;
  private full = '';
  private listeners = new Set<Listener>();

  /** `fn(full, null, null)` at once (when there is a state yet), then `fn(full, patch, slim)` per change. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.full) fn(this.full, null, null);
    return () => this.listeners.delete(fn);
  }

  publish(state: Stateful): void {
    const { next, frames } = diffState(this.fingerprints, state);
    this.fingerprints = next;
    if (!frames) return;
    this.full = frames.full;
    for (const fn of this.listeners) fn(frames.full, frames.patch, frames.slim);
  }
}
