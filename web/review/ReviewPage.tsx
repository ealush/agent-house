import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostApi, State } from '../api.ts';
import { parseReviewHash, reviewApi, reviewHash, STATUS_PILL, STATUS_WORD, type CandidateTree, type Finding, type OwnerSuggestion, type Stack, type StackSummary } from '../reviewApi.ts';
import { askConfirm, askText, showError } from '../ask.tsx';
import { Icon } from '../icons.tsx';
import { Popover } from '../ModelPicker.tsx';
import { age, look } from '../agents.ts';
import { AgentLogo } from '../logos.tsx';
import { Thread } from './Thread.tsx';
import { LayerView, useScrollIntoView } from './Layer.tsx';

const api = reviewApi();
const STATUS_WORDS: Record<string, string> = { busy: 'working', waiting: 'needs you', attention: 'done', idle: 'idle' };
const toast = (text: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: text }));

function useRoute() {
  const [route, setRoute] = useState(() => parseReviewHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseReviewHash(location.hash));
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
    };
  }, []);
  /** A new place is a history entry (Back walks back through layers); fixing up the current one replaces it. */
  const go = useCallback((stack: string | null, pr: number | null, replace = false) => {
    const next = { stack, pr };
    const url = `#${reviewHash(stack, pr)}`;
    const entry = { ah: { page: 'review', selected: null }, back: { page: 'review', selected: null } };
    if (replace) history.replaceState({ ...history.state, ...entry }, '', url);
    else history.pushState(entry, '', url);
    setRoute(next);
  }, []);
  return { ...route, go };
}

// ---------- the list

function TreeRows({ trees, depth, onStart, busy }: { trees: CandidateTree[]; depth: number; onStart: (pr: number, size: number) => void; busy: number | null }) {
  const size = (t: CandidateTree): number => 1 + t.children.reduce((n, c) => n + size(c), 0);
  return (
    <>
      {trees.map((t) => (
        <li key={t.pr.number}>
          <div className="cand" style={{ '--depth': depth } as React.CSSProperties}>
            <span className="mono pr-n">#{t.pr.number}</span>
            <span className="grow name" title={`${t.pr.headRefName} → ${t.pr.baseRefName}`}>
              {t.pr.title}
              {t.pr.draft && <span className="hint"> · draft</span>}
            </span>
            {t.pr.inStack ? (
              <a className="btn ghost small" href={`#${reviewHash(t.pr.inStack)}`}>
                In review
              </a>
            ) : (
              <button className="btn small" disabled={busy !== null} onClick={() => onStart(t.pr.number, size(t))}>
                {busy === t.pr.number ? 'Fetching…' : size(t) > 1 ? `Review ${size(t)}` : 'Review'}
              </button>
            )}
          </div>
          {t.children.length > 0 && (
            <ul className="cands">
              <TreeRows trees={t.children} depth={depth + 1} onStart={onStart} busy={busy} />
            </ul>
          )}
        </li>
      ))}
    </>
  );
}

function Start({ onCreated }: { onCreated: (s: Stack) => void }) {
  const [repos, setRepos] = useState<{ root: string; repo: string; trunk: string }[] | null>(null);
  const [root, setRoot] = useState<string>('');
  const [trees, setTrees] = useState<CandidateTree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    api.repos().then((r) => {
      setRepos(r);
      setRoot((cur) => cur || r[0]?.root || '');
    }, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!root) return;
    setTrees(null);
    setError(null);
    api.candidates(root).then((c) => setTrees(c.trees), (e) => setError(e.message));
  }, [root]);
  const start = async (pr: number) => {
    setBusy(pr);
    try {
      onCreated(await api.create(root, pr));
    } catch (e) {
      showError(e, "Couldn't start the review");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="start-review">
      <div className="section-head">
        <h2 className="section-label first">Open pull requests</h2>
        {repos && repos.length > 1 && (
          <select className="review-select" aria-label="Repository" value={root} onChange={(e) => setRoot(e.target.value)}>
            {repos.map((r) => (
              <option key={r.root} value={r.root}>
                {repos.filter((x) => x.repo === r.repo).length > 1 ? `${r.repo} · ${r.root.replace(/^\/home\/[^/]+/, '~')}` : r.repo}
              </option>
            ))}
          </select>
        )}
        {repos?.length === 1 && <span className="hint">{repos[0].repo}</span>}
      </div>
      {repos?.length === 0 && <p className="hint">No GitHub repository among your sessions' projects. Start a session in one, with gh signed in.</p>}
      {error && <p className="hint">{error}</p>}
      {trees === null && root && !error && <p className="hint">Asking GitHub…</p>}
      {trees?.length === 0 && <p className="hint">No open pull requests.</p>}
      {trees && trees.length > 0 && (
        <>
          <p className="hint">Each row carries what's stacked on it. Review the bottom one to take the whole stack.</p>
          <ul className="cands top">
            <TreeRows trees={trees} depth={0} onStart={start} busy={busy} />
          </ul>
        </>
      )}
    </section>
  );
}

function StackList({ state, onOpen }: { state: State; onOpen: (id: string, pr?: number | null) => void }) {
  const [stacks, setStacks] = useState<StackSummary[] | null>(null);
  const reviewKey = JSON.stringify(state.review?.alerts ?? []);
  useEffect(() => {
    api.stacks().then(setStacks, () => setStacks([]));
  }, [reviewKey]);
  const alerts = state.review?.alerts ?? [];
  const open = stacks?.filter((s) => s.state === 'open') ?? [];
  const done = stacks?.filter((s) => s.state !== 'open') ?? [];
  return (
    <div className="page review-list" data-title="Review" data-rove="button.row">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">
            Review<span className="period">.</span>
          </h1>
          <p className="tagline">
            {stacks === null ? 'Loading…' : open.length ? `${open.length} stack${open.length > 1 ? 's' : ''} in review${alerts.length ? ` · ${alerts.length} need${alerts.length === 1 ? 's' : ''} you` : ''}` : 'Your pull requests, one layer at a time.'}
          </p>
        </div>
      </header>
      {open.length > 0 && (
        <>
          <h2 className="section-label first">In review</h2>
          <ul className="rows">
            {open.map((s) => {
              const mine = alerts.filter((a) => a.stackId === s.id);
              return (
                <li key={s.id}>
                  <button className="row stack-row" onClick={() => onOpen(s.id, mine[0]?.pr ?? s.next)}>
                    <span className="chip">
                      <Icon name="queue" size={14} />
                    </span>
                    <span className="stack">
                      <span className="name">{s.title}</span>
                      <span className="sub">
                        {s.repo} · {s.merged} of {s.layers} merged{s.next ? ` · next #${s.next}` : ''}
                      </span>
                    </span>
                    <span className="when">{mine.length ? <span className="pill waiting">{mine.length} need{mine.length === 1 ? 's' : ''} you</span> : <span className="progress" style={{ '--p': s.layers ? s.merged / s.layers : 0 } as React.CSSProperties} aria-label={`${s.merged} of ${s.layers} merged`} />}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <Start onCreated={(s) => onOpen(s.id, null)} />
      {done.length > 0 && (
        <>
          <h2 className="section-label">Done</h2>
          <ul className="rows">
            {done.map((s) => (
              <li key={s.id}>
                <button className="row quiet" onClick={() => onOpen(s.id)}>
                  <span className="chip">
                    <Icon name="check" size={14} />
                  </span>
                  <span className="stack">
                    <span className="name">{s.title}</span>
                    <span className="sub">
                      {s.repo} · {s.merged} merged
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------- one stack

function RailRow({ stack, pr, current, depth, onPick }: { stack: Stack; pr: number; current: boolean; depth: number; onPick: () => void }) {
  const l = stack.layers.find((x) => x.pr === pr)!;
  const ref = useScrollIntoView(current);
  const i = stack.layers.filter((x) => x.state !== 'skipped' && x.state !== 'closed').findIndex((x) => x.pr === pr);
  return (
    <li>
      <button ref={ref} className={`rail-row ${current ? 'on' : ''} ${l.state}`} aria-current={current ? 'page' : undefined} onClick={onPick} style={{ '--depth': depth } as React.CSSProperties}>
        <span className="rail-n">{l.state === 'merged' ? <Icon name="check" size={13} /> : i >= 0 ? i + 1 : '–'}</span>
        <span className="rail-text">
          <span className="rail-name">
            {l.role && <span className="role-chip sm">{l.role}</span>}
            <span className="t">{l.title}</span>
          </span>
          <span className="rail-sub">
            #{l.pr}
            {l.open ? ` · ${l.open} open` : ''}
            {l.needs ? ` · ${l.needs === 'retarget' ? 'retarget' : l.needs}` : ''}
          </span>
        </span>
        {l.state === 'open' && l.status !== 'unreviewed' && <span className={`pill ${STATUS_PILL[l.status]}`}>{STATUS_WORD[l.status]}</span>}
        {l.state !== 'open' && <span className={`pill ${STATUS_PILL[l.status]}`}>{STATUS_WORD[l.status]}</span>}
      </button>
    </li>
  );
}

function Owner({ stack, onStack, onOpenSession }: { stack: Stack; onStack: (s: Stack) => void; onOpenSession: (uid: string) => void }) {
  const [opts, setOpts] = useState<OwnerSuggestion[] | null>(null);
  useEffect(() => {
    api.owners(stack.id).then(setOpts, () => setOpts([]));
  }, [stack.id]);
  const o = stack.owner;
  return (
    <div className="owner-card">
      <span className="chip" style={{ '--agent': look(o?.agent ?? null).color } as React.CSSProperties}>
        {o ? <AgentLogo id={o.agent} /> : <Icon name="sessions" size={14} />}
      </span>
      <span className="stack">
        <span className="name">{o ? o.title : 'No agent yet'}</span>
        <span className="sub">{o ? `Gets your findings · ${o.live ? (STATUS_WORDS[o.status] ?? o.status) : 'ended; sending resumes it'}` : 'The first findings you send choose it'}</span>
      </span>
      {o?.live && (
        <button className="btn ghost small" onClick={() => onOpenSession(o.uid)}>
          Open
        </button>
      )}
      <Popover label="Change" className="btn ghost small" align="right" up={false}>
        {(close) => (
          <div className="review-menu">
            {opts === null && <p className="hint pad">Looking…</p>}
            {opts?.length === 0 && <p className="hint pad">No agent works in this repository.</p>}
            {opts?.map((s) => (
              <button
                key={s.uid}
                onClick={async () => {
                  close();
                  try {
                    onStack(await api.update(stack.id, { ownerUid: s.uid }));
                  } catch (e) {
                    showError(e, "Couldn't change the owner");
                  }
                }}
              >
                <AgentLogo id={s.agent} size={14} />
                <span className="grow">{s.title}</span>
                <span className="hint">{s.reason === 'branch' ? s.branch : 'same repo'}</span>
                {o?.uid === s.uid && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}

function Overview({ client, stack, onStack, onFindings, onOpenSession }: { client: HostApi; stack: Stack; onStack: (s?: Stack) => void; onFindings: () => void; onOpenSession: (uid: string) => void }) {
  const [plan, setPlan] = useState<{ path: string | null; text: string | null } | null>(null);
  useEffect(() => {
    api.plan(stack.id).then(setPlan, () => setPlan({ path: stack.planPath, text: null }));
  }, [stack.id, stack.planPath]);
  const choosePlan = async () => {
    const path = await askText({ title: 'Plan file', body: "A markdown file with the stack's plan. Its owner table labels the layers (H0, F1…); the reviewer reads the rest.", label: 'Path', placeholder: '~/code/feature-plan.md', value: stack.planPath ?? '', confirm: 'Use it' });
    if (path === null || path === undefined) return;
    try {
      onStack(await api.update(stack.id, { planPath: path.trim() || null }));
    } catch (e) {
      showError(e, "Couldn't use that plan");
    }
  };
  const addDecision = async () => {
    const text = await askText({ title: 'Pin a decision', body: 'Every reviewer answer and every message to the agent holds the code to it.', label: 'Decision', confirm: 'Pin' });
    if (!text?.trim()) return;
    try {
      onStack(await api.addDecision(stack.id, text.trim(), null));
    } catch (e) {
      showError(e, "Couldn't pin it");
    }
  };
  return (
    <div className="stack-overview">
      <div className="overview-cards">
        <Owner stack={stack} onStack={(s) => onStack(s)} onOpenSession={onOpenSession} />
        <section className="overview-card">
          <header>
            <h3>Plan</h3>
            <button className="btn ghost small" onClick={choosePlan}>
              {stack.planPath ? 'Change' : 'Choose file'}
            </button>
          </header>
          {stack.planPath ? <p className="mono hint ellipsis" title={stack.planPath}>{stack.planPath}</p> : <p className="hint">{plan?.text ? "Using the bottom PR's description." : 'None yet. A plan file gives the reviewer your contracts and layer labels.'}</p>}
        </section>
        <section className="overview-card">
          <header>
            <h3>Decisions</h3>
            <button className="btn ghost small" onClick={addDecision}>
              <Icon name="plus" size={14} /> Pin
            </button>
          </header>
          {stack.decisions.length ? (
            <ul className="decisions">
              {stack.decisions.map((d) => (
                <li key={d.id}>
                  <span className="grow">{d.text}</span>
                  <button
                    className="icon-btn"
                    aria-label="Remove decision"
                    onClick={async () => {
                      if (!(await askConfirm({ title: 'Unpin this decision?', body: d.text, confirm: 'Unpin' }))) return;
                      onStack(await api.removeDecision(stack.id, d.id));
                    }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">What you've settled (an invariant, who owns what). The reviewer can suggest them; only you pin them.</p>
          )}
        </section>
      </div>
      <Thread
        client={client}
        api={api}
        stackId={stack.id}
        pr={null}
        layers={stack.layers}
        onSend={() => toast('Open a layer to send to its agent')}
        onDecision={async (seed) => {
          const text = await askText({ title: 'Pin a decision', label: 'Decision', value: seed, confirm: 'Pin' });
          if (text?.trim()) onStack(await api.addDecision(stack.id, text.trim(), null));
        }}
        onChanged={() => {
          onFindings();
          onStack();
        }}
      />
    </div>
  );
}

function StackScreen({ client, state, id, pr, narrow, go, onOpenSession }: { client: HostApi; state: State; id: string; pr: number | null; narrow: boolean; go: (stack: string | null, pr: number | null, replace?: boolean) => void; onOpenSession: (uid: string) => void }) {
  const [stack, setStack] = useState<Stack | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(() => {
    api.stack(id).then((s) => live.current && (setStack(s), setError(null)), (e) => live.current && setError(e.message));
  }, [id]);
  const loadFindings = useCallback(() => {
    api.findings(id).then((f) => live.current && setFindings(f), () => {});
  }, [id]);

  // The host's watcher moves things on (a fix lands, a check passes): reload when its alerts change, and now and then.
  const reviewKey = JSON.stringify(state.review ?? null);
  useEffect(() => {
    load();
    loadFindings();
  }, [id, reviewKey]);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 15_000);
    return () => clearInterval(t);
  }, [id]);
  // A stack just opened syncs in the background; pick up its result.
  useEffect(() => {
    if (!stack?.syncing) return;
    const t = setTimeout(load, 1500);
    return () => clearTimeout(t);
  }, [stack?.syncing, stack?.syncedAt]);

  const order = useMemo(() => stack?.layers.map((l) => l.pr) ?? [], [stack]);
  const layer = stack && pr !== null ? stack.layers.find((l) => l.pr === pr) : null;

  // j / k walk the layers, like a list; not while typing.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const i = pr === null ? -1 : order.indexOf(pr);
      const next = e.key === 'j' ? order[i + 1] : i <= 0 ? null : order[i - 1];
      if (next === undefined) return;
      e.preventDefault();
      go(id, next ?? null, true);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [order, pr, id]);

  if (error && !stack)
    return (
      <div className="page">
        <p className="panel-msg">{error}</p>
        <button className="btn" onClick={() => go(null, null)}>
          All stacks
        </button>
      </div>
    );
  if (!stack) return <div className="page review-stack loading" />;

  const sync = async () => {
    setSyncing(true);
    try {
      setStack(await api.sync(stack.id));
      loadFindings();
    } catch (e) {
      showError(e, "Couldn't refresh from GitHub");
    } finally {
      setSyncing(false);
    }
  };
  const move = async (from: number, by: -1 | 1) => {
    const next = [...order];
    const i = next.indexOf(from);
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    try {
      setStack(await api.update(stack.id, { order: next }));
    } catch (e) {
      showError(e, "Can't go there");
    }
  };
  const merged = stack.layers.filter((l) => l.state === 'merged').length;
  const counted = stack.layers.filter((l) => l.state !== 'skipped' && l.state !== 'closed').length;
  const depthOf = (p: number): number => {
    const l = stack.layers.find((x) => x.pr === p);
    const parent = l && stack.layers.find((x) => x.headRef === l.baseRef && x.state !== 'merged');
    return parent ? Math.min(3, 1 + depthOf(parent.pr)) : 0;
  };

  const menu = (
    <Popover label={<Icon name="more" size={18} />} className="icon-btn round" align="right" up={false} title="Stack">
      {(close) => (
        <div className="review-menu">
          <button
            onClick={async () => {
              close();
              const title = await askText({ title: 'Rename stack', label: 'Name', value: stack.title, confirm: 'Rename' });
              if (title?.trim()) setStack(await api.update(stack.id, { title: title.trim() }));
            }}
          >
            Rename…
          </button>
          {stack.methods.length > 1 &&
            stack.methods.map((m) => (
              <button
                key={m}
                onClick={async () => {
                  close();
                  setStack(await api.update(stack.id, { mergeMethod: m }));
                }}
              >
                <span className="grow">Merge with {m === 'merge' ? 'a merge commit' : m === 'squash' ? 'squash' : 'rebase'}</span>
                {stack.mergeMethod === m && <Icon name="check" size={14} />}
              </button>
            ))}
          {layer && layer.state === 'open' && (
            <>
              <button
                onClick={async () => {
                  close();
                  const role = await askText({ title: `Label #${layer.pr}`, body: 'A short name for the layer (H0, F2, docs).', label: 'Label', value: layer.role, confirm: 'Save' });
                  if (role !== null && role !== undefined) setStack(await api.setLayer(stack.id, layer.pr, { role }));
                }}
              >
                Label this layer…
              </button>
              <button onClick={() => (close(), move(layer.pr, -1))}>Merge earlier</button>
              <button onClick={() => (close(), move(layer.pr, 1))}>Merge later</button>
              <button
                onClick={async () => {
                  close();
                  setStack(await api.setLayer(stack.id, layer.pr, { skipped: true }));
                }}
              >
                Skip this layer (won't merge)
              </button>
            </>
          )}
          {layer?.state === 'skipped' && (
            <button
              onClick={async () => {
                close();
                setStack(await api.setLayer(stack.id, layer.pr, { skipped: false }));
              }}
            >
              Bring this layer back
            </button>
          )}
          <button
            className="danger"
            onClick={async () => {
              close();
              if (!(await askConfirm({ title: `Stop reviewing "${stack.title}"?`, body: 'Its findings, threads and pinned revisions go. Nothing changes on GitHub.', confirm: 'Remove', danger: true }))) return;
              await api.remove(stack.id);
              go(null, null);
            }}
          >
            Remove from Review
          </button>
        </div>
      )}
    </Popover>
  );

  const rail = (
    <nav className="layer-rail" aria-label="Layers" data-rove="button.rail-row, button.rail-stack">
      <button className={`rail-stack ${pr === null ? 'on' : ''}`} onClick={() => go(stack.id, null, true)}>
        <Icon name="queue" size={15} />
        <span className="grow">Stack overview</span>
        {stack.decisions.length > 0 && <span className="count">{stack.decisions.length}</span>}
      </button>
      <ol className="rail-list">
        {stack.layers.map((l) => (
          <RailRow key={l.pr} stack={stack} pr={l.pr} current={l.pr === pr} depth={depthOf(l.pr)} onPick={() => go(stack.id, l.pr, true)} />
        ))}
      </ol>
    </nav>
  );

  const head = (
    <header className="review-head">
      <button className="icon-btn round" onClick={() => (narrow && pr !== null ? go(stack.id, null) : go(null, null))} aria-label={narrow && pr !== null ? 'Back to the stack' : 'All stacks'}>
        <Icon name="back" size={20} />
      </button>
      <div className="grow">
        <h1 className="review-title">{stack.title}</h1>
        <p className="tagline">
          {stack.repo} · into {stack.trunk} · {merged} of {counted} merged · {stack.syncError ? <span className="bad">{stack.syncError}</span> : stack.syncing || syncing ? 'refreshing…' : `checked ${age(stack.syncedAt)} ago`}
        </p>
      </div>
      <button className="icon-btn round" onClick={sync} disabled={syncing} aria-label="Refresh from GitHub" title="Refresh from GitHub">
        <Icon name="reload" size={17} />
      </button>
      {menu}
    </header>
  );

  const body = layer ? (
    <LayerView
      client={client}
      api={api}
      stack={stack}
      layer={layer}
      findings={findings}
      narrow={narrow}
      onStack={(s) => (s ? setStack(s) : load())}
      onFindings={loadFindings}
      onNavigate={(next) => go(stack.id, next, true)}
      onOpenSession={onOpenSession}
    />
  ) : (
    <Overview client={client} stack={stack} onStack={(s) => (s ? setStack(s) : load())} onFindings={loadFindings} onOpenSession={onOpenSession} />
  );

  if (narrow)
    return (
      <div className="page review-stack phone" data-title={stack.title}>
        {head}
        {pr === null ? (
          <>
            {rail}
            {body}
          </>
        ) : (
          body
        )}
      </div>
    );

  return (
    <div className="review-stack" data-title={stack.title}>
      {head}
      <div className="review-grid">
        {rail}
        <div className="review-main">{body}</div>
      </div>
    </div>
  );
}

/** The Review page: stacks in review and how to start one; a stack, its layers, one layer. */
export default function ReviewPage({ client, state, narrow, onOpenSession }: { client: HostApi; state: State; narrow: boolean; onOpenSession: (uid: string) => void }) {
  const { stack, pr, go } = useRoute();
  if (!stack) return <StackList state={state} onOpen={(id, p) => go(id, p ?? null)} />;
  return <StackScreen key={stack} client={client} state={state} id={stack} pr={pr} narrow={narrow} go={go} onOpenSession={onOpenSession} />;
}
