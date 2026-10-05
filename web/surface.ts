// A session is rendered by exactly one surface at a time. Each is its own component
// tree with its own transport: the terminal attaches to the tmux window, the GUI
// reads typed transcript events. Session.tsx picks one from SURFACES and shares
// only what both have: the header and side panels. The graphical composer lives
// only in the GUI view; the terminal supplies its own input.
import { lazy, type ComponentType, type RefAttributes } from 'react';
import type { HostApi, Win } from './api.ts';
import { TerminalSurface } from './TerminalSurface.tsx';

export type SurfaceHandle = {
  /** Put text in the agent's input without submitting it (a file path, a snippet). */
  insert: (text: string) => void;
  focus: () => void;
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

export const SURFACES: Record<View, ComponentType<SurfaceProps & RefAttributes<SurfaceHandle>>> = {
  terminal: TerminalSurface,
  // Loaded on first use: the terminal-only path never downloads the GUI tree.
  gui: lazy(() => import('./gui/GuiSurface.tsx')),
};

export const VIEW_LABEL: Record<View, string> = { terminal: 'Terminal', gui: 'GUI' };

/** The GUI needs a transcript adapter; everything can be a terminal. */
export function viewsFor(w: Win): View[] {
  return w.feed ? ['terminal', 'gui'] : ['terminal'];
}
