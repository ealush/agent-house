import { createContext, useContext } from 'react';
import type { HostApi } from '../api.ts';

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
  /** Run in Terminal on code in a live agent's reply: a shell in the session's folder runs it
   *  (`web/runInShell.ts`). `place` says where: "ah · main". */
  snippetRun?: { place: string; run: (snippet: string) => void };
  /** Open the subagent a Delegate card's call spawned, by the call's id (server/subagents). */
  openSubagent?: (callId: string) => void;
  /** "@path" in a message: where to look for its file, and opening it (web/mentions.ts). */
  mentions?: { fs: HostApi['fs']; cwd: string; open: (path: string) => void };
};

export const GuiContext = createContext<GuiActions>({ reply: () => {}, fileUrl: () => '#', resolvePath: (p) => p, displayPath: (p) => p });
export const useGui = () => useContext(GuiContext);
