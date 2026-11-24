import { useCallback, useEffect, useState } from 'react';
import type { HostApi, Job, JobRun, JobTrigger, State } from './api.ts';
import { age, look } from './agents.ts';
import { DecisionCard } from './DecisionCard.tsx';
import { errorText } from './errors.ts';

const STATE_WORD: Record<string, string> = { scheduled: 'scheduled', waiting: 'needs you', paused: 'paused', done: 'done', failed: 'failed', cancelled: 'cancelled' };
const RUN_WORD: Record<string, string> = { eligible: 'waiting its turn', running: 'running', succeeded: 'done', failed: 'failed', uncertain: 'uncertain', cancelled: 'cancelled', skipped: 'skipped', waiting: 'needs you' };

const when = (at: number) => new Date(at * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A trigger as you'd say it. */
export function triggerWords(t: JobTrigger, jobs: Job[]): string {
  switch (t.kind) {
    case 'at':
      return `At ${when(t.at)}`;
    case 'every': {
      const s = t.seconds;
      const span = s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`;
      return `Every ${span}`;
    }
    case 'cron': {
      const m = t.expr.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/);
      if (m) return `${m[3] === '*' ? 'Every day' : 'Weekdays'} at ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')} (${t.tz})`;
      return `On schedule ${t.expr} (${t.tz})`;
    }
    case 'after': {
      const name = jobs.find((j) => j.id === t.job)?.name ?? t.job;
      return t.on === 'any' ? `After ${name}` : `After ${name} ${t.on === 'success' ? 'succeeds' : 'fails'}`;
    }
    case 'session': {
      const who = t.uid === '*' ? 'any session' : 'its session';
      const what = t.on === 'waiting' ? 'needs you' : t.on === 'stalled' ? 'stalls' : t.on === 'idle' ? 'finishes a turn' : 'ends';
      return `${t.repeat ? 'Whenever' : 'When'} ${who} ${what}`;
    }
    case 'overlap':
      return `${t.repeat ? 'Whenever' : 'When'} checkouts overlap${t.repo ? ` in ${t.repo}` : ''}`;
    default:
      return 'When you run it';
  }
}

type Props = { state: State; client: HostApi; onOpenSession: (uid: string) => void };

/** Scheduled and conditional agent work on this host (server/jobs). */
export function JobsView({ state, client, onOpenSession }: Props) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [adding, setAdding] = useState(false);
  const reload = useCallback(() => {
    client.jobs().then((r) => setJobs(r.jobs), (e) => setError(errorText(e)));
  }, [client]);
  // The stream carries the summary; the list follows it.
  useEffect(reload, [reload, JSON.stringify(state.jobs)]);
  useEffect(() => {
    if (!open) return;
    client.job(open).then((j) => setRuns(j.runs), () => setRuns([]));
  }, [client, open, jobs]);
  const act = (id: string, verb: 'pause' | 'resume' | 'cancel' | 'run') => void client.jobVerb(id, verb).then(reload, (e) => setError(errorText(e)));
  const waiting = state.jobs?.waiting ?? [];
  const uncertain = state.jobs?.uncertain ?? [];

  return (
    <div className="page" data-title="Jobs">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">
            Jobs<span className="period">.</span>
          </h1>
          <p className="tagline">Agent work on a schedule, after other work, or when a session settles. It runs here, with no page open.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(!adding)}>
          New job
        </button>
      </header>
      {error && <p className="form-error">{error}</p>}
      {adding && <NewJob state={state} client={client} jobs={jobs ?? []} onCreated={() => (setAdding(false), reload())} onCancel={() => setAdding(false)} />}
      {waiting.length > 0 && (
        <>
          <h2 className="section-label waiting first">
            Needs your decision <span className="count">{waiting.length}</span>
          </h2>
          <div className="cards">
            {waiting.map((d) => (
              <DecisionCard key={d.runId} d={d} client={client} onDone={reload} />
            ))}
          </div>
        </>
      )}
      {uncertain.length > 0 && (
        <>
          <h2 className="section-label">Not sure it arrived</h2>
          <p className="hint">ah stopped while delivering these. Check the session, then send again or leave it.</p>
          <ul className="rows">
            {uncertain.map((u) => (
              <li key={u.runId} className="row quiet">
                <span className="grow">{u.name}</span>
                <button className="btn small" onClick={() => void client.resolveRun(u.runId, true).then(reload, (e) => setError(errorText(e)))}>
                  Send again
                </button>
                <button className="btn small ghost" onClick={() => void client.resolveRun(u.runId, false).then(reload, (e) => setError(errorText(e)))}>
                  Leave it
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {jobs && jobs.length === 0 && !adding && <p className="empty-state">No jobs yet. A job starts an agent or messages a session at a time, every morning, or after another job.</p>}
      {jobs && jobs.length > 0 && (
        <ul className="rows jobs-list">
          {jobs.map((j) => (
            <li key={j.id} className={open === j.id ? 'open' : undefined}>
              <div className="row quiet job-row">
                <button className="stack grow" onClick={() => setOpen(open === j.id ? null : j.id)} aria-expanded={open === j.id}>
                  <span className="name">{j.name}</span>
                  <span className="sub">
                    {triggerWords(j.trigger, jobs)}
                    {j.action.kind === 'launch' ? ` · starts ${look(j.action.preset).name}` : j.action.kind === 'send' ? ' · messages a session' : ' · asks you'}
                    {j.nextRunAt ? ` · next ${when(j.nextRunAt)}` : ''}
                  </span>
                </button>
                <span className={`pill ${j.state === 'waiting' ? 'waiting' : j.state === 'failed' ? 'danger' : ''}`}>{STATE_WORD[j.state] ?? j.state}</span>
                <span className="row-actions">
                  {j.state !== 'cancelled' && (
                    <button className="btn small ghost" onClick={() => act(j.id, 'run')}>
                      Run now
                    </button>
                  )}
                  {j.state === 'paused' ? (
                    <button className="btn small ghost" onClick={() => act(j.id, 'resume')}>
                      Resume
                    </button>
                  ) : ['scheduled', 'waiting'].includes(j.state) ? (
                    <button className="btn small ghost" onClick={() => act(j.id, 'pause')}>
                      Pause
                    </button>
                  ) : null}
                  {!['cancelled', 'done'].includes(j.state) && (
                    <button className="btn small ghost danger" onClick={() => act(j.id, 'cancel')}>
                      Cancel
                    </button>
                  )}
                </span>
              </div>
              {open === j.id && (
                <ul className="job-runs">
                  {runs.length === 0 && <li className="hint">It hasn't run yet.</li>}
                  {runs.slice(0, 10).map((r) => (
                    <li key={r.id}>
                      <span className={`pill ${r.state === 'failed' || r.state === 'uncertain' ? 'danger' : r.state === 'waiting' ? 'waiting' : ''}`}>{RUN_WORD[r.state] ?? r.state}</span>
                      <span className="grow">
                        {r.startedAt ? age(r.startedAt) : r.scheduledFor ? `due ${when(r.scheduledFor)}` : ''}
                        {r.attempt > 1 ? ` · try ${r.attempt}` : ''}
                        {r.error ? ` · ${r.error}` : r.outcome.skippedBecause ? ` · ${r.outcome.skippedBecause}` : r.outcome.reply ? ` · ${r.outcome.reply.split('\n')[0].slice(0, 140)}` : ''}
                      </span>
                      {r.sessionUid && (
                        <button className="btn small ghost" onClick={() => onOpenSession(r.sessionUid!)}>
                          Open session
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A new job in the common shapes: start an agent with a prompt, now, at a time, daily, or after another job. */
function NewJob({ state, client, jobs, onCreated, onCancel }: { state: State; client: HostApi; jobs: Job[]; onCreated: () => void; onCancel: () => void }) {
  const agents = state.presets.filter((p) => p.available && !p.hidden && p.command && p.id !== 'shell');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState(agents[0]?.id ?? '');
  const [cwd, setCwd] = useState(state.windows.find((w) => w.agent)?.cwd ?? '~');
  const [prompt, setPrompt] = useState('');
  const [whenKind, setWhenKind] = useState<'now' | 'at' | 'daily' | 'after'>('now');
  const [at, setAt] = useState('');
  const [daily, setDaily] = useState('09:00');
  const [after, setAfter] = useState(jobs[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let trigger: JobTrigger;
    if (whenKind === 'at') trigger = { kind: 'at', at: Math.floor(new Date(at).getTime() / 1000) };
    else if (whenKind === 'daily') {
      const [h, m] = daily.split(':').map(Number);
      trigger = { kind: 'cron', expr: `${m} ${h} * * *`, tz };
    } else if (whenKind === 'after') trigger = { kind: 'after', job: after, on: 'success' };
    else trigger = { kind: 'manual' };
    try {
      const job = await client.createJob({ name: name.trim() || prompt.split('\n')[0].slice(0, 60) || 'Job', action: { kind: 'launch', preset, cwd: cwd.replace(/^~(?=\/|$)/, state.home), prompt }, trigger });
      if (whenKind === 'now') await client.jobVerb(job.id, 'run');
      onCreated();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <form className="job-form" onSubmit={submit}>
      <label className="field">
        <span>Agent</span>
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          {agents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Folder</span>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} autoCapitalize="off" />
      </label>
      <label className="field">
        <span>What to ask</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} required placeholder="Run the test suite and fix what fails." />
      </label>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly tests" />
      </label>
      <div className="field">
        <span>When</span>
        <div className="seg" role="radiogroup" aria-label="When">
          {(['now', 'at', 'daily', 'after'] as const).map((k) => (
            <button type="button" key={k} role="radio" aria-checked={whenKind === k} className={whenKind === k ? 'on' : ''} onClick={() => setWhenKind(k)} disabled={k === 'after' && !jobs.length}>
              {k === 'now' ? 'Now' : k === 'at' ? 'At a time' : k === 'daily' ? 'Every day' : 'After a job'}
            </button>
          ))}
        </div>
      </div>
      {whenKind === 'at' && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required aria-label="When" />}
      {whenKind === 'daily' && <input type="time" value={daily} onChange={(e) => setDaily(e.target.value)} required aria-label="Time of day" />}
      {whenKind === 'after' && (
        <select value={after} onChange={(e) => setAfter(e.target.value)} aria-label="After which job">
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name} succeeds
            </option>
          ))}
        </select>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          {whenKind === 'now' ? 'Start' : 'Schedule'}
        </button>
      </div>
    </form>
  );
}
