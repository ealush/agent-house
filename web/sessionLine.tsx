// The one line under a session's title, wherever a list shows it (the switcher, the
// pane chooser, the phone's Sessions, History), chosen by what the session is doing
// (design system SessionRow): what it needs from you; else what it is doing now;
// else which agent and model it is. Ended ones say so. The project leads only when
// the list isn't already grouped by project, the host only with several hosts.
// Commands read as code, everything else as words.
import { Fragment, type ReactNode } from 'react';
import type { HistoryItem, Win } from './api.ts';
import { look, shortModel } from './agents.ts';
import { readAsk } from './askView.ts';

type Where = { project?: boolean; host?: boolean };

const join = (parts: ReactNode[]): ReactNode => (
  <>
    {parts
      .filter((p) => p !== null && p !== undefined && p !== '')
      .map((p, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          {p}
        </Fragment>
      ))}
  </>
);

/** A detail line that is a command ("$ pnpm test") reads as code; anything else as words. */
function detailNode(detail: string): ReactNode {
  return detail.startsWith('$ ') ? (
    <span key="d" className="mono">
      {detail}
    </span>
  ) : (
    detail
  );
}

function doing(w: Win): ReactNode {
  if (w.status === 'waiting' && w.ask) {
    const ask = readAsk(w.ask, w.detail);
    if (ask.command)
      return (
        <span key="a">
          Wants to run{' '}
          <span className="mono" key="c">
            {ask.command}
          </span>
        </span>
      );
    return ask.question ?? ask.kind;
  }
  if (w.limit && w.status !== 'busy') return w.limit;
  if (w.detail) return detailNode(w.detail);
  if (w.panes > 1) return `${w.panes} panes`;
  return join([w.agent ? look(w.agent).name : 'Shell', shortModel(w.model)]);
}

/** A live session's line. */
export function sessionLine(w: Win, where: Where = {}): ReactNode {
  return join([where.host ? w.host : null, where.project ? w.project : null, doing(w)]);
}

/** A past conversation's line: which agent and model, where, and that it ended. */
export function historyLine(h: HistoryItem, where: Where = {}): ReactNode {
  return join([
    where.host ? h.host : null,
    where.project ? h.project : null,
    look(h.harness).name,
    shortModel(h.model),
    h.interrupted ? (h.interrupted.midTurn ? 'interrupted mid-turn' : 'interrupted') : h.kind === 'ended' ? 'ended' : null,
    h.worktree ? '⎇ worktree' : null,
    h.fork ? `⑂ fork of ${h.fork.parentTitle}` : null,
    h.continued?.kind === 'migration' ? `↪ from ${h.continued.fromHost ?? 'another host'}` : h.continued && h.continued.kind !== 'fork' ? `↪ from ${look(h.continued.fromHarness).name}` : null,
    h.moved ? `→ moved to ${h.moved.host}` : null,
  ]);
}
