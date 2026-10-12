import { createContext, useContext } from 'react';

/** What renderers may do back to the session. Everything goes through the same
 *  send path as the terminal, so the agent sees it as text it can reason about. */
export type GuiActions = {
  /** Send a message as the user (queued if the agent is busy). */
  reply: (text: string) => void;
  /** URL for a file on the session's host, via the files API (confined to its roots). */
  fileUrl: (path: string) => string;
  /** Absolute form of a path the agent wrote relative to its cwd or ~. */
  resolvePath: (path: string) => string;
  /** A path as a person reads it: relative to the project when it is inside it. */
  displayPath: (path: string) => string;
};

export const GuiContext = createContext<GuiActions>({ reply: () => {}, fileUrl: () => '#', resolvePath: (p) => p, displayPath: (p) => p });
export const useGui = () => useContext(GuiContext);
