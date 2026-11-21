import { useState } from 'react';
import type { HostApi, JobsState } from './api.ts';
import { Icon } from './icons.tsx';
import { errorText } from './errors.ts';

/**
 * A scheduled workflow waiting on you (server/jobs): what it asks, what led here
 * (the reply it carries), and the two answers. Going ahead runs its follow-up.
 */
export function DecisionCard({ d, client, onDone }: { d: JobsState['waiting'][number]; client: HostApi; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await client.decideRun(d.runId, approve);
      onDone?.();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <article className="card card-needs card-decision" data-flip={`decision:${d.runId}`}>
      <div className="card-head">
        <span className="glow">
          <span className="chip">
            <Icon name="flag" size={14} />
          </span>
        </span>
        <span className="card-title">{d.title}</span>
      </div>
      {d.body && <p className="decision-body">{d.body.length > 600 ? `${d.body.slice(0, 600)}…` : d.body}</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="card-foot">
        <button className="btn primary" disabled={busy} onClick={() => void answer(true)}>
          Go ahead
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void answer(false)}>
          Stop here
        </button>
        <span className="meta">
          <span className="tag">{d.name}</span>
        </span>
      </div>
    </article>
  );
}
