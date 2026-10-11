// A session is rendered by exactly one surface at a time. Each is its own component
// tree with its own transport: the terminal attaches to the tmux window, the GUI
// reads typed transcript events. Session.tsx picks one with surfaceFor and shares
// only what both have: the header and side panels. The graphical composer lives
// only in the GUI view; the terminal supplies its own input.
import { lazy, type ComponentType, type RefAttributes } from 'react';
import type { HostApi, Win } from './api.ts';

export type SurfaceHandle = {
  /** Put text in the agent's input without submitting it (a file path, a snippet). */
  insert: (text: string) => void;
  focus: () => void;
  /** Move focus to the answer controls of a waiting session. False when there are none. */
  focusAsk?: () => boolean;
  /** Copy the agent's newest reply (GUI). */
  copyLast?: () => void;
  /** Scroll to the newest output. */
  jumpLatest?: () => void;
  /** Put the keyboard on the newest message, to walk the conversation (GUI). */
  browse?: () => boolean;
};

export type SurfaceProps = {
  w: Win;
  client: HostApi;
  /** Another tab (Diff, Files) is showing on a phone; stay mounted and connected. */
  hidden: boolean;
  showKeys: boolean;
  onAnswer: (w: Win, answer: 'approve' | 'deny') => void;
  /** Focus input to answer in words (composer in GUI, terminal otherwise). */
  onReply: () => void;
  /** Some interactions exist only in the agent's TUI (its own pickers). */
  onUseTerminal: () => void;
  refresh: () => void;
};

export type View = 'terminal' | 'gui';

type Surface = ComponentType<SurfaceProps & RefAttributes<SurfaceHandle>>;

// Loaded on first use: the terminal-only path never downloads the GUI tree.
let gui: Surface | null = null;
const loadGui = () =>
  import('./gui/GuiSurface.tsx').then((m) => {
    gui = m.default;
    return m;
  });
const LazyGui = lazy(loadGui);

/**
 * The view a device starts in until you pick one: the GUI on touch screens,
 * where it reads and answers better than a terminal; the terminal elsewhere.
 */
export function defaultView(): View {
  try {
    return matchMedia('(pointer: coarse)').matches ? 'gui' : 'terminal';
  } catch {
    return 'terminal';
  }
}

// The terminal (xterm and its WebGL renderer, the biggest dependency) loads the
// same way: at boot only on devices that start in it, otherwise on first use.
let term: Surface | null = null;
const loadTerminal = () =>
  import('./TerminalSurface.tsx').then((m) => {
    term = m.TerminalSurface;
    return { default: m.TerminalSurface };
  });
const LazyTerminal = lazy(loadTerminal);

// Whichever view this device starts in is fetched at boot, next to the session list.
// Once loaded it is used directly: a lazy component suspends on every first mount,
// and React holds a suspended reveal back for a moment, which a reload would show.
// The other one follows once the page has settled, so switching views never waits.
try {
  const gui = (localStorage.getItem('ah.view') ?? defaultView()) === 'gui';
  void (gui ? loadGui() : loadTerminal());
  setTimeout(() => void (gui ? loadTerminal() : loadGui()), 4000);
} catch {}

export function surfaceFor(view: View): Surface {
  return view === 'gui' ? (gui ?? LazyGui) : (term ?? LazyTerminal);
}

export const VIEW_LABEL: Record<View, string> = { terminal: 'Terminal', gui: 'GUI' };

/** The GUI needs a transcript adapter; everything can be a terminal. */
export function viewsFor(w: Win): View[] {
  return w.feed ? ['gui', 'terminal'] : ['terminal'];
}
