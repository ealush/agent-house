import { useState } from 'react';
import type { HistoryItem, HostApi, InterruptCause, Interrupted, InterruptionsState } from './api.ts';
import { AgentLogo } from './logos.tsx';
import { Icon } from './icons.tsx';
import { errorText } from './errors.ts';
import { look } from './agents.ts';

const WHY: Record<InterruptCause, string> = {
  tmux_server: 'The tmux server stopped',
  host_restart: 'The host restarted',
  window: 'Its window was closed',
};

const clock = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "The tmux server stopped at 3:38 PM": what cut it off, and when. */
export function interruptedLine(i: Pick<Interrupted, 'cause' | 'at'>, plural = false): string {
  const why = i.cause === 'window' && plural ? 'Their windows were closed' : WHY[i.cause];
  return `${why} at ${clock(i.at)}`;
}

/** What it was doing when it was cut off. */
export const wasWord = (i: Pick<Interrupted, 'midTurn' | 'lastStatus'>) => (!i.midTurn ? 'had finished' : i.lastStatus === 'waiting' ? 'was asking' : 'was working');

/**
 * Sessions cut off together (server/interruptions): which, what each was doing, and one
 * step to bring them all back. Mid-turn ones go first and are told where they stopped.
 */
export function InterruptedCard({ incident, sessions, client, onOpen }: { incident: InterruptionsState['incidents'][number]; sessions: HistoryItem[]; client: HostApi; onOpen: (h: HistoryItem) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const n = incident.count;
  const act = async (key: string, run: () => Promise<{ failed?: Array<{ error: string }> } | unknown>) => {
    setBusy(key);
    setError(null);
    try {
      const out = (await run()) as { failed?: Array<{ error: string }> };
      if (out?.failed?.length) setError(`${out.failed.length} couldn't be restored: ${out.failed[0].error}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  // One whose row isn't in History (it lists only so many) is still one: never "1 sessions".
  const title = n === 1 ? (sessions[0] ? `${sessions[0].title} was interrupted` : 'A session was interrupted') : `${n} sessions were interrupted`;
  const working = incident.midTurn;
  return (
    <article className="card card-needs card-interrupted" data-flip={`interrupted:${incident.id}`} aria-label={title}>
      <div className="card-head">
        <span className="glow">
          <span className="chip">
            <Icon name="reload" size={14} />
          </span>
        </span>
        <span className="card-title">{title}</span>
      </div>
      <p className="decision-body">
        {interruptedLine(incident, n > 1)}
        {working ? `; ${working} ${working === 1 ? 'was' : 'were'} working` : ''}.{' '}
        {incident.reviving
          ? `ah is bringing ${n === 1 ? 'it' : 'them'} back.`
          : `Restoring resumes each in its own conversation${working ? ', and tells the ones that were working where they stopped' : ''}.`}
      </p>
      {sessions.filter((h) => h.interrupted?.failed).map((h) => (
        <p key={`failed-${h.ref}`} className="form-error">
          {n === 1 ? "It didn't come back" : `${h.title} didn't come back`}: {h.interrupted!.failed!.error}
        </p>
      ))}
      {n > 1 && (
        <ul className="interrupted-list">
          {sessions.map((h) => (
            <li key={h.ref}>
              <button className="interrupted-row" onClick={() => onOpen(h)} title={`Open ${h.title}`}>
                <span className="chip sm" style={{ '--agent': look(h.harness).color } as React.CSSProperties}>
                  <AgentLogo id={h.harness} size={13} />
                </span>
                <span className="grow">{h.title}</span>
                <span className={`tag ${h.interrupted?.midTurn ? 'mid' : ''}`}>{h.interrupted ? wasWord(h.interrupted) : ''}</span>
              </button>
              <button className="btn small ghost" disabled={!!busy} onClick={() => void act(h.ref, () => client.restore(h.ref))}>
                {busy === h.ref ? 'Restoring…' : 'Restore'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="card-foot">
        <button className="btn primary" disabled={!!busy} onClick={() => void act('all', () => client.restoreInterrupted({ incident: incident.id }))}>
          {busy === 'all' ? 'Restoring…' : n === 1 ? 'Restore' : 'Restore all'}
        </button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void act('dismiss', () => client.dismissInterrupted({ incident: incident.id }))}>
          Dismiss
        </button>
        {n === 1 && sessions[0]?.interrupted && (
          <span className="meta">
            <span className="tag">{wasWord(sessions[0].interrupted)}</span>
          </span>
        )}
      </div>
    </article>
  );
}
