// The stack a session is building, beside it: its branches bottom to top, each
// with its PR as it appears and its place in review, and the review itself (or
// a button that starts one, made by this session). Read from gh stack's own
// tracking, else from the PRs based on each other.
import { useContext, useEffect, useState } from 'react';
import { reviewApi, toneOf, type SessionStack, type Tone } from '../reviewApi.ts';
import { ReviewContext } from '../reviewContext.ts';
import { showError } from '../ask.tsx';
import { Dot } from './Spine.tsx';
import './review.css';
import { every } from '../poll.ts';

const api = reviewApi();
const SHORT: Record<string, string> = { unreviewed: 'To review', changes: 'To send', fixing: 'Agent fixing', rereview: 'Came back', approved: 'Reviewed', merged: 'Merged', closed: 'Closed', skipped: 'Skipped' };

type Row = SessionStack['branches'][number];

function tone(r: Row): Tone {
  if (r.layer) return toneOf(r.layer.status);
  if (!r.pr) return 'off';
  return r.pr.state === 'MERGED' ? 'merged' : r.pr.state === 'CLOSED' ? 'off' : 'todo';
}

function state(r: Row): string {
  if (!r.pr) return 'No PR yet';
  if (r.layer) return SHORT[r.layer.status] ?? r.layer.status;
  if (r.pr.state !== 'OPEN') return r.pr.state === 'MERGED' ? 'Merged' : 'Closed';
  return r.pr.draft ? 'Draft' : 'Open';
}

function checks(r: Row): { text: string; cls: string } | null {
  const c = r.pr?.checks;
  if (!c || r.pr?.state !== 'OPEN') return null;
  if (c.fail) return { text: `${c.fail} failing`, cls: 'bad' };
  if (c.pending) return { text: `${c.pending} running`, cls: 'run' };
  return c.pass ? { text: 'Checks pass', cls: '' } : null;
}

export default function SessionStackPanel({ uid }: { uid: string }) {
  const ctx = useContext(ReviewContext);
  const [data, setData] = useState<SessionStack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.sessionStack(uid).then(
        (d) => live && (setData(d), setError(null)),
        (e) => live && setError(e.message),
      );
    load();
    // PRs appear as the agent opens them.
    const stop = every(10_000, load);
    return () => {
      live = false;
      stop();
    };
  }, [uid]);

  const start = async () => {
    if (!data?.start) return;
    setBusy(true);
    try {
      const root = data.root;
      const s = await api.create(root, data.start, undefined, uid);
      ctx?.open(s.id, null);
    } catch (e) {
      showError(e, "Couldn't start the review");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="panel-body"><p className="panel-msg">{error}</p></div>;
  if (!data) return <div className="panel-body"><p className="panel-msg">Looking…</p></div>;
  if (!data.repo) return <div className="panel-body"><p className="panel-msg">Not a GitHub repository, or gh isn't signed in here.</p></div>;
  if (!data.branches.length)
    return (
      <div className="panel-body">
        <p className="panel-msg">No stack here yet. When the agent stacks branches with gh stack, or opens PRs based on each other, they show here as they're made.</p>
      </div>
    );

  const prs = data.branches.filter((b) => b.pr).length;
  return (
    <div className="panel-body session-stack">
      <header className="ss-head">
        <span className="section-label first">Stack</span>
        <span className="hint">
          {[`into ${data.trunk}`, data.ghStack !== null ? `GitHub stack #${data.ghStack}` : data.source === 'gh-stack' ? 'gh stack' : 'PRs based on each other', `${prs} of ${data.branches.length} with a PR`].join(' · ')}
        </span>
      </header>
      <ol className="ss-list">
        <li className="ss-trunk mono">
          <span className="ss-rail">
            <span className="sdot trunk sm" aria-hidden />
          </span>
          {data.trunk}
        </li>
        {data.branches.map((r, i) => {
          const c = checks(r);
          return (
            <li key={r.branch} className={`ss-row ${r.current ? 'here' : ''}`}>
              <span className="ss-rail">
                <Dot tone={tone(r)} size="sm" />
              </span>
              <span className="ss-body">
                <span className="ss-top">
                  <span className="mono faint">{r.layer?.role || i + 1}</span>
                  {r.pr ? (
                    <a className="ss-title" href={r.pr.url} target="_blank" rel="noreferrer" title={`#${r.pr.number} on GitHub`}>
                      <span className="mono faint">#{r.pr.number}</span> {r.pr.title}
                    </a>
                  ) : (
                    <span className="ss-title faint">{r.branch}</span>
                  )}
                </span>
                <span className="ss-sub">
                  <span className="mono">{r.branch}</span>
                  {r.current && <span className="ss-here">here</span>}
                  <span>{state(r)}</span>
                  {c && <span className={c.cls}>{c.text}</span>}
                  {r.pr && r.pr.state === 'OPEN' && (
                    <span className="mono">
                      <span className="add-n">+{r.pr.additions}</span> <span className="del-n">−{r.pr.deletions}</span>
                    </span>
                  )}
                </span>
              </span>
              {r.layer && data.review && (
                <button className="btn ghost small" onClick={() => ctx?.open(data.review!.id, r.pr!.number)} aria-label={`Open #${r.pr!.number} in Review`}>
                  Review
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <footer className="ss-foot">
        {data.review ? (
          <button className="btn" onClick={() => ctx?.open(data.review!.id, null)}>
            Open in Review
          </button>
        ) : data.start ? (
          <>
            <button className="btn primary" disabled={busy} onClick={start}>
              {busy ? 'Starting…' : 'Review this stack'}
            </button>
            <p className="hint">This session is recorded as where the stack was made: fixes come back here, and the reviewer reads this conversation.</p>
          </>
        ) : (
          <p className="hint">Once its branches have PRs (gh stack submit), you can review the stack here.</p>
        )}
      </footer>
    </div>
  );
}
