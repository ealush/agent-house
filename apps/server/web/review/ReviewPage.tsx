import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostApi, ReviewAlert, State } from '../api.ts';
import { parseReviewHash, reviewApi, reviewHash, STATUS_WORD, toneOf, type Attachment, type Candidates, type Finding, type Layer, type OwnerSuggestion, type Stack, type StackSummary } from '../reviewApi.ts';
import { askConfirm, askText, showError } from '../ask.tsx';
import { ConfirmButton } from '../ConfirmButton.tsx';
import { Icon } from '../icons.tsx';
import { Popover } from '../ModelPicker.tsx';
import { age, look } from '../agents.ts';
import { AgentLogo } from '../logos.tsx';
import { Thread } from './Thread.tsx';
import { LayerView, stored } from './Layer.tsx';
import { DispatchDialog, PlanDialog } from './Dispatch.tsx';
import { Compose, rememberRoot } from './Compose.tsx';
import { Dot, Spine, SpineBar, SpineColumn, layerLine } from './Spine.tsx';
import { StackMergeDialog } from './StackMerge.tsx';
import { ReviewerSheet } from './ReviewerSheet.tsx';
import { planStackMerge, type Method } from './stackMerge.ts';
import './review.css';

const api = reviewApi();
const STATUS_WORDS: Record<string, string> = { busy: 'working', waiting: 'needs you', attention: 'done', idle: 'idle' };
const toast = (text: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: text }));
const ago = (t: number) => (age(t) === 'now' ? 'just now' : `${age(t)} ago`);
const SHORT: Record<Layer['status'], string> = { unreviewed: 'To review', changes: 'To send', fixing: 'Agent fixing', rereview: 'Came back', approved: 'Reviewed', merged: 'Merged', closed: 'Closed', skipped: 'Skipped' };
const ALERT_WORD: Record<ReviewAlert['kind'], string> = { rereview: 'came back', nopush: 'finished without a push', restack: 'needs a restack', ready: 'is ready to merge' };

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
  const go = useCallback((stack: string | null, pr: number | null, opts: { replace?: boolean; pick?: boolean } = {}) => {
    const url = `#${reviewHash(stack, pr, opts.pick)}`;
    const entry = { ah: { page: 'review', selected: null }, back: { page: 'review', selected: null } };
    if (opts.replace) history.replaceState({ ...history.state, ...entry }, '', url);
    else history.pushState(entry, '', url);
    setRoute({ stack, pr, pick: !!opts.pick });
  }, []);
  return { ...route, go };
}

// ---------- the list

// A project's open PRs, kept a minute: the list asks for every project at once.
const cands = new Map<string, { at: number; v: Promise<Candidates> }>();
function candidatesOf(root: string): Promise<Candidates> {
  const hit = cands.get(root);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = api.candidates(root);
  cands.set(root, { at: Date.now(), v });
  v.catch(() => cands.delete(root));
  return v;
}

function ProjectCard({ root, repo, onPick }: { root: string; repo: string; onPick: () => void }) {
  const [c, setC] = useState<Candidates | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    candidatesOf(root).then(setC, () => setErr(true));
  }, [root]);
  const name = repo.split('/').pop() ?? repo;
  const lines: string[] = [];
  let open = 0;
  if (c) {
    const size = (t: Candidates['trees'][number]): number => 1 + t.children.reduce((n, x) => n + size(x), 0);
    const free = (t: Candidates['trees'][number]): boolean => !t.pr.inStack && t.children.every(free);
    open = c.trees.reduce((n, t) => n + size(t), 0);
    for (const t of c.trees.filter((t) => t.children.length && free(t)).slice(0, 2)) lines.push(`Chain of ${size(t)} on #${t.pr.number}`);
    const single = c.trees.filter((t) => !t.children.length && !t.pr.inStack).length;
    if (single) lines.push(`${single} on their own`);
    for (const s of c.stacks.slice(0, 2)) {
      const n = [...c.trees].flatMap(function all(t): Candidates['trees'] {
        return [t, ...t.children.flatMap(all)];
      }).filter((t) => t.pr.inStack === s.id).length;
      if (n) lines.push(`${n} in ${s.title}`);
    }
  }
  return (
    <button className="project-card" onClick={onPick}>
      <span className="project-top">
        <span className="project-mark" aria-hidden>
          {name.slice(0, 1)}
        </span>
        <span className="stack">
          <span className="name">{name}</span>
          <span className="sub">{repo}</span>
        </span>
        <span className="project-n" aria-label={c ? `${open} open pull requests` : undefined}>
          {c ? open : err ? '–' : ''}
        </span>
      </span>
      <span className="project-lines">
        {!c && !err && <span className="hint">Asking GitHub…</span>}
        {err && <span className="hint">Couldn't ask GitHub</span>}
        {c && open === 0 && <span className="hint">No open pull requests</span>}
        {lines.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </span>
    </button>
  );
}

const ALERT_RANK: ReviewAlert['kind'][] = ['rereview', 'nopush', 'restack', 'ready'];
const byRank = (alerts: ReviewAlert[]) => [...alerts].sort((a, b) => ALERT_RANK.indexOf(a.kind) - ALERT_RANK.indexOf(b.kind));

function stackPill(s: StackSummary, alerts: ReviewAlert[]): { tone: string; text: string } | null {
  const a = byRank(alerts)[0];
  if (a) return { tone: 'needs', text: `${a.role || `#${a.pr}`} ${ALERT_WORD[a.kind]}` };
  const busy = s.spine.find((x) => x.status === 'fixing');
  if (busy) return { tone: 'busy', text: `Fixing ${busy.role || `#${busy.pr}`}` };
  const next = s.spine.find((x) => x.pr === s.next);
  if (next) return { tone: 'todo', text: `Next: ${next.role || `#${next.pr}`}` };
  return null;
}

function StackList({ state, narrow, onOpen, onPick, onOpenSession }: { state: State; narrow: boolean; onOpen: (id: string, pr?: number | null) => void; onPick: () => void; onOpenSession: (uid: string) => void }) {
  const [stacks, setStacks] = useState<StackSummary[] | null>(null);
  const [repos, setRepos] = useState<{ root: string; repo: string; trunk: string }[] | null>(null);
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());
  const reviewKey = JSON.stringify(state.review?.alerts ?? []);
  useEffect(() => {
    api.stacks().then(setStacks, () => setStacks([]));
  }, [reviewKey]);
  useEffect(() => {
    api.repos().then(setRepos, () => setRepos([]));
  }, []);
  const removeStack = async (s: StackSummary) => {
    if (removing.has(s.id)) return;
    const ok = await askConfirm({
      title: `Remove "${s.title}" from Review?`,
      body: 'Its findings, threads and pinned revisions are removed from Review. Nothing changes on GitHub.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setRemoving((prev) => new Set([...prev, s.id]));
    try {
      await api.remove(s.id);
      setStacks((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
      toast(`Removed "${s.title}"`);
    } catch (e) {
      showError(e, "Couldn't remove from Review");
    } finally {
      setRemoving((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
  };
  const alerts = state.review?.alerts ?? [];
  const open = stacks?.filter((s) => s.state === 'open') ?? [];
  const done = stacks?.filter((s) => s.state !== 'open') ?? [];
  // No stacks and no GitHub repository to start one from.
  const nothing = repos?.length === 0 && open.length === 0 && done.length === 0;
  return (
    <div className="page review-list" data-title="Review" data-rove="button.stack-card, button.project-card">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">
            Review<span className="period">.</span>
          </h1>
          <p className="tagline">
            {stacks === null ? 'Loading…' : open.length ? (
              <>
                {open.length} stack{open.length > 1 ? 's' : ''} in review
                {alerts.length > 0 && (
                  <>
                    {' · '}
                    <span className="accent">
                      {alerts.length} need{alerts.length === 1 ? 's' : ''} you
                    </span>
                  </>
                )}
              </>
            ) : (
              'Your pull requests, one layer at a time.'
            )}
          </p>
        </div>
        {/* A stack starts from a project's pull requests: with none to start from, no button that leads nowhere. */}
        {!nothing && (
          <button className="btn light new-stack" onClick={onPick}>
            <Icon name="plus" size={16} /> New stack
          </button>
        )}
      </header>
      {nothing && (
        <div className="empty-state">
          <p className="empty-title">Nothing to review yet.</p>
          <p className="hint">No GitHub repository among your sessions' Spaces. Start a session in one, with gh signed in, and its pull requests show here.</p>
        </div>
      )}
      {open.length > 0 && (
        <section className="list-section">
          <h2 className="section-label first">In review</h2>
          <ul className="stack-cards">
            {open.map((s) => {
              const mine = alerts.filter((a) => a.stackId === s.id);
              const pill = stackPill(s, mine);
              const sess = s.origin ?? s.owner ?? null;
              const checks = s.checks;
              const isRemoving = removing.has(s.id);
              return (
                <li key={s.id} className={`stack-card-wrap${isRemoving ? ' removing' : ''}`}>
                  <button className="stack-card" disabled={isRemoving} onClick={() => onOpen(s.id, byRank(mine)[0]?.pr ?? null)}>
                    <span className="stack">
                      <span className="name">{s.title}</span>
                      <span className="sub">
                        {s.repo} · {s.source === 'manual' ? 'picked by hand' : s.source === 'native' ? `GitHub stack #${s.ghStack} into ${s.trunk}` : `into ${s.trunk}`} · {s.merged} of {s.layers} merged
                      </span>
                      <span className="stack-glance">
                        {s.readyToMerge && <span className="glance-pill ok">Ready for {s.trunk}</span>}
                        {checks && (checks.fail > 0 ? <span className="glance-pill bad">{checks.fail} check{checks.fail === 1 ? '' : 's'} failing</span> : checks.pending > 0 ? <span className="glance-pill run">{checks.pending} running</span> : checks.pass > 0 ? <span className="glance-pill ok">Checks pass</span> : null)}
                        {(s.blockingFindings ?? 0) > 0 ? (
                          <span className="glance-pill bad">{s.blockingFindings} blocking</span>
                        ) : (s.openFindings ?? 0) > 0 ? (
                          <span className="glance-pill warn">{s.openFindings} comment{s.openFindings === 1 ? '' : 's'}</span>
                        ) : null}
                        {(s.files ?? 0) > 0 && (
                          <span className="glance-stat mono">
                            {s.files}f <span className="add-n">+{s.additions ?? 0}</span> <span className="del-n">−{s.deletions ?? 0}</span>
                          </span>
                        )}
                      </span>
                    </span>
                    {!narrow && (
                      <span className="stack-progress">
                        <SpineBar spine={s.spine} />
                        <span className="roles mono">{s.spine.map((x) => x.role || `#${x.pr}`).join(' · ')}</span>
                      </span>
                    )}
                    <span className="stack-state">
                      {pill && <span className={`tone-pill ${pill.tone}`}>{pill.text}</span>}
                      <span className="fwd" aria-hidden><Icon name="back" size={16} /></span>
                    </span>
                    {narrow && <SpineBar spine={s.spine} />}
                  </button>
                  <div className="stack-card-foot">
                    {sess ? (
                      <button
                        type="button"
                        className="session-link-chip"
                        onClick={() => onOpenSession(sess.uid)}
                        title={`Open linked session "${sess.title}"`}
                      >
                        <AgentLogo id={sess.agent} size={13} />
                        <span className="ellipsis">{sess.title}</span>
                        <span className={`dot-mini ${sess.live ? 'live' : 'off'}`} aria-hidden />
                      </button>
                    ) : (
                      <span className="hint small-note">No linked session</span>
                    )}
                    <button
                      type="button"
                      className="btn ghost small danger-text stack-remove-btn"
                      disabled={isRemoving}
                      onClick={() => void removeStack(s)}
                      aria-label={`Remove ${s.title} from Review`}
                      title="Remove from Review (nothing changes on GitHub)"
                    >
                      <Icon name="trash" size={13} />
                      {isRemoving ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {!nothing && <section className="list-section">
        <div className="section-head">
          <h2 className={`section-label ${open.length ? '' : 'first'}`}>Start from a Space</h2>
          <span className="hint">Open pull requests in your sessions' Spaces</span>
        </div>
        {repos === null && <p className="hint">Looking at your Spaces…</p>}
        {repos?.length === 0 && <p className="hint">No GitHub repository among your sessions' Spaces. Start a session in one, with gh signed in.</p>}
        {repos && repos.length > 0 && (
          <div className="project-cards">
            {repos.map((r) => (
              <ProjectCard key={r.root} root={r.root} repo={repos.filter((x) => x.repo === r.repo).length > 1 ? `${r.repo} · ${r.root.replace(/^\/home\/[^/]+/, '~')}` : r.repo} onPick={() => (rememberRoot(r.root), onPick())} />
            ))}
          </div>
        )}
      </section>}
      {done.length > 0 && (
        <section className="list-section">
          <h2 className="section-label">Done</h2>
          <ul className="rows">
            {done.map((s) => {
              const isRemoving = removing.has(s.id);
              return (
                <li key={s.id} className="done-row-wrap">
                  <button className="row quiet grow" disabled={isRemoving} onClick={() => onOpen(s.id)}>
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
                  <button
                    type="button"
                    className="icon-btn done-remove-btn"
                    disabled={isRemoving}
                    onClick={() => void removeStack(s)}
                    aria-label={`Remove ${s.title} from Review`}
                    title="Remove from Review"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------- one stack

/**
 * A session the stack is tied to: the one fixes go to, or the one that made it
 * (whose conversation, live or ended, is the why behind the stack).
 */
function SessionCard({ kind, stack, onStack, onOpenSession }: { kind: 'owner' | 'origin'; stack: Stack; onStack: (s: Stack) => void; onOpenSession: (uid: string) => void }) {
  const [opts, setOpts] = useState<OwnerSuggestion[] | null>(null);
  useEffect(() => {
    api.owners(stack.id).then(setOpts, () => setOpts([]));
  }, [stack.id, stack.origin?.key]);
  const o = kind === 'owner' ? stack.owner : stack.origin;
  const empty = kind === 'owner' ? { name: 'No agent yet', sub: 'The first findings you send choose it' } : { name: 'Not recorded', sub: 'Pick the session that built it: the reviewer reads its conversation' };
  return (
    <section className="cockpit-card">
      <h3 className="card-label">{kind === 'owner' ? 'Fixes go to' : 'Made in'}</h3>
      <div className="owner-line">
        <span className="chip" style={{ '--agent': look(o?.agent ?? null).color } as React.CSSProperties}>
          {o ? <AgentLogo id={o.agent} /> : <Icon name="sessions" size={14} />}
        </span>
        <span className="stack">
          <span className="name">{o ? o.title : empty.name}</span>
          <span className="sub">{o ? [look(o.agent).name, o.live ? (STATUS_WORDS[o.status] ?? o.status) : kind === 'owner' ? 'ended; sending resumes it' : 'ended', o.branch ? `on ${o.branch}` : ''].filter(Boolean).join(' · ') : empty.sub}</span>
        </span>
      </div>
      <div className="card-actions">
        {o && (o.live || kind === 'origin') && (
          <button className="btn small" onClick={() => onOpenSession(o.uid)} title={o.live ? undefined : 'Its conversation, read-only; you can resume it there'}>
            {o.live ? 'Open session' : 'Read the conversation'}
          </button>
        )}
        <Popover label="Change" className="btn ghost small" align="left" up={false}>
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
                      onStack(await api.update(stack.id, kind === 'owner' ? { ownerUid: s.uid } : { originUid: s.uid }));
                    } catch (e) {
                      showError(e, kind === 'owner' ? "Couldn't change the owner" : "Couldn't change it");
                    }
                  }}
                >
                  <AgentLogo id={s.agent} size={14} />
                  <span className="grow">{s.title}</span>
                  <span className="hint">{s.origin && kind === 'owner' ? 'made it' : !s.live ? 'ended' : s.reason === 'branch' ? s.branch : 'same repo'}</span>
                  {o?.uid === s.uid && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
          )}
        </Popover>
      </div>
    </section>
  );
}

type Next = { tone: 'needs' | 'busy' | 'ready' | 'todo' | 'done'; eyebrow: string; title: string; body: string; pr: number | null; action: string | null; merge?: boolean };

/** The one thing to do next on the stack, and the button that does it. */
function upNext(stack: Stack, alerts: ReviewAlert[]): Next {
  const name = (l: Layer) => l.role || `#${l.pr}`;
  const open = stack.layers.filter((l) => l.state === 'open');
  const agent = stack.owner?.agent ? look(stack.owner.agent).name : 'the agent';
  const who = (l: Layer) => (l.dispatch?.targetAgent ? look(l.dispatch.targetAgent).name : agent);
  const a = byRank(alerts)[0];
  const al = a && stack.layers.find((l) => l.pr === a.pr);
  if (a && al) {
    const v = al.current?.verdict;
    if (a.kind === 'rereview') {
      const fixed = v?.items.filter((i) => i.verdict === 'addressed').length ?? 0;
      const partly = v?.items.filter((i) => i.verdict !== 'addressed').length ?? 0;
      return {
        tone: 'needs',
        eyebrow: 'Up next',
        title: `${name(al)} came back from ${who(al)}`,
        body: v ? `The reviewer checked the push: ${v.summary || `${fixed} fixed${partly ? `, ${partly} not fully` : ''}.`}` : "It changed since your review. The diff shows what's new.",
        pr: al.pr,
        action: `Re-review ${name(al)}`,
      };
    }
    if (a.kind === 'nopush') return { tone: 'needs', eyebrow: 'Up next', title: `${who(al)} finished ${name(al)} without pushing`, body: 'Look at the session, or send the findings again.', pr: al.pr, action: `Open ${name(al)}` };
    if (a.kind === 'restack')
      return { tone: 'needs', eyebrow: 'Up next', title: `${name(al)} needs a restack`, body: al.ghStack !== null ? `It no longer sits on top of ${al.baseRef}. GitHub won't merge the stack until it does.` : `The layer under it merged. Its own commits need moving onto ${stack.trunk}.`, pr: al.pr, action: `Open ${name(al)}` };
    return { tone: 'ready', eyebrow: 'Up next', title: `${name(al)} is ready to merge`, body: al.title, pr: al.pr, action: `Open ${name(al)}` };
  }
  const changes = open.find((l) => l.status === 'changes');
  // Every layer reviewed and nothing holding any back: the stack goes in one go.
  const plan = planStackMerge(stack, stack.mergeMethod);
  if (open.length > 1 && !changes && plan.lands.length === open.length && !plan.review.length)
    return { tone: 'ready', eyebrow: 'Up next', title: 'The stack is ready to merge', body: `${open.length} layers into ${stack.trunk}, bottom up.`, pr: null, action: 'Merge the stack', merge: true };
  if (changes) return { tone: 'needs', eyebrow: 'Up next', title: `${name(changes)} has ${changes.open} finding${changes.open === 1 ? '' : 's'} to send`, body: changes.title, pr: changes.pr, action: `Open ${name(changes)}` };
  const first = open.find((l) => l.status !== 'skipped');
  if (first?.status === 'approved' && first.gates.every((g) => g.ok)) return { tone: 'ready', eyebrow: 'Up next', title: `${name(first)} is ready to merge`, body: first.title, pr: first.pr, action: `Open ${name(first)}` };
  const todo = open.find((l) => l.status === 'unreviewed');
  if (todo) {
    const r = todo.current;
    return { tone: 'todo', eyebrow: 'Up next', title: `Review ${name(todo)}`, body: `${todo.title}${r ? ` · ${r.files} file${r.files === 1 ? '' : 's'}, +${r.additions} −${r.deletions}` : ''}`, pr: todo.pr, action: `Review ${name(todo)}` };
  }
  const fixing = open.find((l) => l.status === 'fixing');
  if (fixing?.dispatch?.kind === 'merge') return { tone: 'busy', eyebrow: 'Waiting', title: `${who(fixing)} is merging the stack${fixing.pr === open.at(-1)?.pr ? '' : ` up to ${name(fixing)}`}`, body: 'The layers turn merged as GitHub lands them. You get a push if it stops short.', pr: fixing.pr, action: null };
  if (fixing) return { tone: 'busy', eyebrow: 'Waiting', title: `${who(fixing)} is fixing ${name(fixing)}`, body: 'You get a push and an Inbox card when it comes back.', pr: fixing.pr, action: null };
  if (first) return { tone: 'todo', eyebrow: 'Up next', title: `${name(first)}: ${STATUS_WORD[first.status].toLowerCase()}`, body: first.title, pr: first.pr, action: `Open ${name(first)}` };
  return { tone: 'done', eyebrow: 'Done', title: 'Every layer is merged or closed', body: `${stack.layers.filter((l) => l.state === 'merged').length} merged into ${stack.trunk}.`, pr: null, action: null };
}

function UpNext({ next, onOpen, onMerge }: { next: Next; onOpen: (pr: number) => void; onMerge: () => void }) {
  return (
    <section className={`up-next ${next.tone}`}>
      <span className="up-mark" aria-hidden>
        <Icon name={next.tone === 'needs' ? 'reload' : next.tone === 'busy' ? 'sessions' : next.tone === 'done' || next.tone === 'ready' ? 'check' : 'diff'} size={20} />
      </span>
      <div className="grow">
        <span className="eyebrow">{next.eyebrow}</span>
        <h2>{next.title}</h2>
        <p>{next.body}</p>
      </div>
      {next.action && (next.pr !== null || next.merge) && (
        <ConfirmButton className="btn primary" onClick={() => (next.merge ? onMerge() : onOpen(next.pr!))}>
          {next.action}
        </ConfirmButton>
      )}
    </section>
  );
}

function MergeTable({ stack, onOpen, onMerge }: { stack: Stack; onOpen: (pr: number) => void; onMerge: () => void }) {
  const counts = new Map<string, number>();
  for (const l of stack.layers) counts.set(toneOf(l.status), (counts.get(toneOf(l.status)) ?? 0) + 1);
  const said = [
    ['merged', 'merged'],
    ['ready', 'reviewed'],
    ['needs', 'need you'],
    ['busy', 'fixing'],
    ['todo', 'to review'],
  ]
    .filter(([k]) => counts.get(k))
    .map(([k, w]) => `${counts.get(k)} ${w}`)
    .join(' · ');
  return (
    <section className="merge-order">
      <div className="section-head">
        <h2 className="section-label first">Merge order</h2>
        <span className="hint grow">{said}</span>
        {stack.layers.some((l) => l.state === 'open') && (
          <button className="btn small merge-all" onClick={onMerge}>
            Merge the stack…
          </button>
        )}
      </div>
      <div className="merge-table" role="table" aria-label="Layers in merge order">
        <div className="mt-row head" role="row">
          <span role="columnheader">Layer</span>
          <span role="columnheader">Pull request</span>
          <span role="columnheader">Status</span>
          <span role="columnheader" className="mt-f">
            Findings
          </span>
          <span role="columnheader" className="mt-c">
            Checks
          </span>
        </div>
        {stack.layers.map((l, i) => {
          const tone = toneOf(l.status);
          const sent = l.dispatch && (l.dispatch.state === 'sent' || l.dispatch.state === 'working') ? l.dispatch.findings.length : 0;
          return (
            <button key={l.pr} className={`mt-row ${tone}`} role="row" onClick={() => onOpen(l.pr)}>
              <span className="mono role" role="cell">
                {l.role || i + 1}
              </span>
              <span className="mt-title" role="cell">
                <span className="mono faint">#{l.pr}</span>
                <span className="t">{l.title}</span>
              </span>
              <span role="cell">
                <span className={`tone-pill ${tone}`}>
                  <Dot tone={tone} size="sm" />
                  {l.status === 'fixing' && l.dispatch?.kind === 'merge' ? 'Agent merging' : SHORT[l.status]}
                </span>
              </span>
              <span className="mt-f" role="cell">
                {l.open ? `${l.open} open` : sent ? `${sent} sent` : '—'}
              </span>
              <span className={`mt-c ${l.checks.fail ? 'bad' : l.checks.pending ? 'run' : ''}`} role="cell">
                {l.checks.fail ? `${l.checks.fail} failing` : l.checks.pending ? `${l.checks.pending} running` : l.checks.pass ? 'Pass' : '—'}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Cockpit({ stack, alerts, narrow, onStack, onOpen, onOpenSession, onPick, onMerge }: { stack: Stack; alerts: ReviewAlert[]; narrow: boolean; onStack: (s?: Stack) => void; onOpen: (pr: number | null) => void; onOpenSession: (uid: string) => void; onPick: () => void; onMerge: () => void }) {
  const [plan, setPlan] = useState<{ path: string | null; text: string | null } | null>(null);
  const [reading, setReading] = useState(false);
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
  const next = upNext(stack, alerts);
  return (
    <div className="cockpit">
      {reading && <PlanDialog path={stack.planPath} text={plan?.text ?? null} image={(src) => api.imageUrl(stack.id, src)} onClose={() => setReading(false)} />}
      <UpNext next={next} onOpen={(pr) => onOpen(pr)} onMerge={onMerge} />
      {narrow ? (
        <Spine stack={stack} pr={null} onPick={onOpen} />
      ) : (
        <MergeTable stack={stack} onOpen={(pr) => onOpen(pr)} onMerge={onMerge} />
      )}
      {stack.state === 'open' && (
        <button className="add-prs" onClick={onPick}>
          <Icon name="plus" size={15} /> Add pull requests
        </button>
      )}
      <div className="cockpit-cards">
        <SessionCard kind="origin" stack={stack} onStack={(s) => onStack(s)} onOpenSession={onOpenSession} />
        <SessionCard kind="owner" stack={stack} onStack={(s) => onStack(s)} onOpenSession={onOpenSession} />
        <section className="cockpit-card">
          <h3 className="card-label">Plan</h3>
          {stack.planPath ? (
            <>
              <p className="plan-path" title={stack.planPath}>
                {stack.planPath.split('/').pop()}
              </p>
              <p className="hint">Names the layers and their owners. The reviewer reads it with every question.</p>
            </>
          ) : (
            <p className="hint">{plan?.text ? "Using the first PR's description. A plan file gives the reviewer your contracts and labels the layers." : 'None yet. A plan gives the reviewer your contracts and labels the layers.'}</p>
          )}
          <div className="card-actions">
            {plan?.text && (
              <button className="btn small" onClick={() => setReading(true)}>
                Read
              </button>
            )}
            <button className="btn ghost small" onClick={choosePlan}>
              {stack.planPath ? 'Change' : 'Choose a file'}
            </button>
          </div>
        </section>
        <section className="cockpit-card">
          <h3 className="card-label">Decisions{stack.decisions.length ? ` · ${stack.decisions.length}` : ''}</h3>
          {stack.decisions.length ? (
            <ul className="decisions">
              {stack.decisions.map((d) => (
                <li key={d.id}>
                  <span className="grow">{d.text}</span>
                  <button
                    className="icon-btn"
                    aria-label="Unpin decision"
                    onClick={async () => {
                      if (!(await askConfirm({ title: 'Unpin this decision?', body: d.text, confirm: 'Unpin' }))) return;
                      try {
                        onStack(await api.removeDecision(stack.id, d.id));
                        toast('Decision unpinned');
                      } catch (e) {
                        showError(e, "Couldn't unpin decision");
                      }
                    }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">What you've settled: an invariant, who owns what. The reviewer and the agent are held to it.</p>
          )}
          <div className="card-actions">
            <button className="btn ghost small accent-link" onClick={addDecision}>
              Pin a decision
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function StackScreen({ client, state, id, pr, pick, narrow, go, onOpenSession }: { client: HostApi; state: State; id: string; pr: number | null; pick: boolean; narrow: boolean; go: (stack: string | null, pr: number | null, opts?: { replace?: boolean; pick?: boolean }) => void; onOpenSession: (uid: string) => void }) {
  const [stack, setStack] = useState<Stack | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // On a phone the reviewer is a sheet on the overview and a tab on a layer; on a desktop it's a panel beside both.
  const [asking, setAsking] = useState(false);
  const [panel, setPanel] = stored<'open' | 'closed'>('ah.review.panel', 'open');
  // Under 900px there's no room beside the page: the reviewer floats over it when asked for, and folds back.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  const compact = !narrow && width < 900;
  const [floating, setFloating] = useState(false);
  const shown = compact ? floating : panel === 'open';
  const showPanel = (on: boolean) => (compact ? setFloating(on) : setPanel(on ? 'open' : 'closed'));
  // What you've brought to the reviewer and not asked about yet; it waits while you move between layers.
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [focus, setFocus] = useState({ n: 0, text: '' });
  // A reviewer answer you're sending to the agent, from the layer you're on.
  const [handing, setHanding] = useState<string | null>(null);
  const [mergingAll, setMergingAll] = useState(false);
  // Merging handed to the agent: up to which layer, and how.
  const [agentMerge, setAgentMerge] = useState<{ upTo: number; method: Method } | null>(null);
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
  const open = (p: number | null) => go(id, p, { replace: !narrow || p !== null });

  // j / k walk the layers, like a list; not while typing.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || pick) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const i = pr === null ? -1 : order.indexOf(pr);
      const next = e.key === 'j' ? order[i + 1] : i <= 0 ? null : order[i - 1];
      if (next === undefined) return;
      e.preventDefault();
      go(id, next ?? null, { replace: true });
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [order, pr, id, pick]);

  if (error && !stack)
    return (
      <div className="page">
        <p className="panel-msg">{error}</p>
        <button className="btn" onClick={() => go(null, null)}>
          All stacks
        </button>
      </div>
    );
  if (!stack)
    return (
      <div className="page review-stack loading">
        <p className="panel-msg">Loading review…</p>
      </div>
    );

  if (pick)
    return (
      <Compose
        stack={stack}
        narrow={narrow}
        onBack={() => history.back()}
        onDone={(s) => {
          setStack(s);
          toast('Added to the stack');
          go(s.id, null, { replace: true });
        }}
      />
    );

  const sync = async () => {
    setSyncing(true);
    try {
      setStack(await api.sync(stack.id));
      loadFindings();
      toast('Refreshed from GitHub');
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
  const ghStacks = [...new Set(stack.layers.filter((l) => l.state === 'open' && l.ghStack !== null).map((l) => l.ghStack!))];
  const counted = stack.layers.filter((l) => l.state !== 'skipped' && l.state !== 'closed').length;
  const alerts = (state.review?.alerts ?? []).filter((a) => a.stackId === stack.id);
  const activeLayer = layer?.state === 'open' ? layer : stack.layers.find((l) => l.pr === stack.next && l.state === 'open') ?? stack.layers.find((l) => l.state === 'open') ?? null;
  const targetSession = stack.owner ?? stack.origin;

  const stackItems = (close: () => void) => (
    <>
      {stack.layers.some((l) => l.state === 'open') && <button onClick={() => (close(), setMergingAll(true))}>Merge the stack…</button>}
      <button onClick={() => (close(), go(stack.id, null, { pick: true }))}>Add pull requests…</button>
      <button
        onClick={async () => {
          close();
          const title = await askText({ title: 'Rename stack', label: 'Name', value: stack.title, confirm: 'Rename' });
          if (!title?.trim()) return;
          try {
            setStack(await api.update(stack.id, { title: title.trim() }));
            toast('Renamed');
          } catch (e) {
            showError(e, "Couldn't rename the stack");
          }
        }}
      >
        Rename…
      </button>
      {stack.link && (
        <button
          disabled={!stack.link.ok}
          title={stack.link.why ?? undefined}
          onClick={async () => {
            close();
            const l = stack.link!;
            const names = l.prs.map((n) => `#${n}`).join(', ');
            const ok = await askConfirm({
              title: l.onto === null ? 'Make these a stack on GitHub?' : `Add ${l.prs.length === 1 ? 'this' : 'these'} to stack #${l.onto} on GitHub?`,
              body: `${names} ${l.onto === null ? 'become a stack on GitHub, bottom to top' : `go on top of stack #${l.onto}`}. GitHub then merges a PR with the PRs under it, and rebases the rest itself. Unstack it on GitHub to undo.`,
              confirm: l.onto === null ? 'Make a stack' : 'Add to the stack',
            });
            if (!ok) return;
            try {
              setStack(await api.link(stack.id));
              toast('A stack on GitHub now');
            } catch (e) {
              showError(e, "Couldn't make the stack on GitHub");
            }
          }}
        >
          {stack.link.ok ? (stack.link.onto === null ? 'Make it a stack on GitHub…' : `Add to stack #${stack.link.onto} on GitHub…`) : `Not a stack on GitHub: ${stack.link.why}`}
        </button>
      )}
      {stack.methods.length > 1 &&
        stack.methods.map((m) => (
          <button
            key={m}
            onClick={async () => {
              close();
              try {
                setStack(await api.update(stack.id, { mergeMethod: m }));
                toast(`Merge method: ${m}`);
              } catch (e) {
                showError(e, "Couldn't change merge method");
              }
            }}
          >
            <span className="grow">Merge with {m === 'merge' ? 'a merge commit' : m === 'squash' ? 'squash' : 'rebase'}</span>
            {stack.mergeMethod === m && <Icon name="check" size={14} />}
          </button>
        ))}
      <button
        className="danger"
        onClick={async () => {
          close();
          if (!(await askConfirm({ title: `Remove "${stack.title}" from Review?`, body: 'Its findings, threads and pinned revisions are removed from Review. Nothing changes on GitHub.', confirm: 'Remove', danger: true }))) return;
          try {
            await api.remove(stack.id);
            toast('Removed from Review');
            go(null, null);
          } catch (e) {
            showError(e, "Couldn't remove from Review");
          }
        }}
      >
        Remove from Review
      </button>
    </>
  );

  const layerItems = (l: Layer) => (close: () => void) => (
    <>
      {l.state === 'open' && <button onClick={() => (close(), setMergingAll(true))}>Merge the stack…</button>}
      {l.state === 'open' && (
        <>
          <button
            onClick={async () => {
              close();
              const role = await askText({ title: `Label #${l.pr}`, body: 'A short name for the layer (H0, F2, docs).', label: 'Label', value: l.role, confirm: 'Save' });
              if (role === null || role === undefined) return;
              try {
                setStack(await api.setLayer(stack.id, l.pr, { role }));
              } catch (e) {
                showError(e, "Couldn't update label");
              }
            }}
          >
            Label this layer…
          </button>
          <button onClick={() => (close(), move(l.pr, -1))}>Merge earlier</button>
          <button onClick={() => (close(), move(l.pr, 1))}>Merge later</button>
          <button
            onClick={async () => {
              close();
              try {
                setStack(await api.setLayer(stack.id, l.pr, { skipped: true }));
                toast(`Skipped #${l.pr}`);
              } catch (e) {
                showError(e, "Couldn't skip layer");
              }
            }}
          >
            Skip (won't merge)
          </button>
        </>
      )}
      {l.state === 'skipped' && (
        <button
          onClick={async () => {
            close();
            try {
              setStack(await api.setLayer(stack.id, l.pr, { skipped: false }));
              toast(`Brought #${l.pr} back`);
            } catch (e) {
              showError(e, "Couldn't restore layer");
            }
          }}
        >
          Bring this layer back
        </button>
      )}
      {stack.layers.length > 1 && (
        <button
          className="danger"
          onClick={async () => {
            close();
            if (!(await askConfirm({ title: `Take #${l.pr} out of the stack?`, body: `Its findings and threads go. Nothing changes on GitHub.${stack.source === 'tree' ? " New PRs on the stack's branches stop joining it." : stack.source === 'native' ? ` It stops following GitHub's stack #${stack.ghStack}.` : ''}`, confirm: 'Take out', danger: true }))) return;
            try {
              setStack(await api.removeLayer(stack.id, l.pr));
              toast(`Removed #${l.pr} from stack`);
              go(stack.id, null, { replace: true });
            } catch (e) {
              showError(e, "Couldn't take it out");
            }
          }}
        >
          Take out of the stack
        </button>
      )}
    </>
  );

  const discuss = (a: Attachment, note = '') => {
    setAttached((xs) => (xs.some((x) => x.key === a.key) ? xs : [...xs, a].slice(-8)));
    showPanel(true);
    if (narrow) setAsking(true);
    setFocus((f) => ({ n: f.n + 1, text: note }));
  };
  const pinDecision = async (seed: string) => {
    const text = await askText({ title: 'Pin a decision', body: 'Every reviewer answer and every message to the agent holds the code to it.', label: 'Decision', value: seed, confirm: 'Pin' });
    if (!text?.trim()) return;
    try {
      setStack(await api.addDecision(stack.id, text.trim(), layer?.pr ?? null));
      toast('Decision pinned');
    } catch (e) {
      showError(e, "Couldn't pin it");
    }
  };

  const reviewer = (
    <Thread
      client={client}
      api={api}
      stackId={stack.id}
      pr={layer?.pr ?? null}
      layers={stack.layers}
      attached={attached}
      onDetach={(key) => setAttached((xs) => (key === null ? [] : xs.filter((x) => x.key !== key)))}
      focus={focus}
      onHide={narrow ? () => setAsking(false) : () => showPanel(false)}
      sheet={narrow}
      sessionLabel={targetSession?.title ?? (targetSession?.agent ? look(targetSession.agent).name : null)}
      onSend={(text) => (activeLayer ? setHanding(text) : toast('No open pull request left to send to'))}
      onDecision={pinDecision}
      onChanged={() => {
        loadFindings();
        load();
      }}
    />
  );

  const mergeAll = mergingAll && (
    <StackMergeDialog
      api={api}
      stack={stack}
      onClose={() => setMergingAll(false)}
      onMerged={() => {
        load();
        loadFindings();
      }}
      onAskAgent={(method, upTo) => setAgentMerge({ method, upTo })}
    />
  );
  const agentLayer = agentMerge && stack.layers.find((l) => l.pr === agentMerge.upTo);
  const askMerge = agentMerge && agentLayer && (
    <DispatchDialog
      api={api}
      stack={stack}
      layer={agentLayer}
      findingIds={[]}
      extra=""
      kind="merge"
      method={agentMerge.method}
      onClose={() => setAgentMerge(null)}
      onSent={(outcome, to) => {
        toast(outcome === 'queued' ? `Merge queued for ${to}` : `Asked ${to} to merge`);
        load();
      }}
    />
  );

  const handoff = handing !== null && activeLayer && (
    <DispatchDialog
      api={api}
      stack={stack}
      layer={activeLayer}
      findingIds={[]}
      extra={handing}
      onClose={() => setHanding(null)}
      onSent={(outcome, to) => {
        toast(outcome === 'queued' ? `Queued for ${to}` : `Sent to ${to}`);
        load();
        loadFindings();
      }}
    />
  );

  // Beside the overview and every layer: the reviewer, or the rail it folds to (and, when narrow, floats over from).
  const rail = (
    <aside className="reviewer-rail" aria-label="Reviewer">
      <button className="icon-btn round" onClick={() => showPanel(true)} aria-label="Show the reviewer" title="Show the reviewer" aria-expanded={shown}>
        <Icon name="sparkle" size={18} />
      </button>
      {attached.length > 0 && <span className="count">{attached.length}</span>}
    </aside>
  );
  const side = !shown ? (
    rail
  ) : compact ? (
    <>
      {rail}
      <aside className="reviewer-panel floating" aria-label="Reviewer" onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && showPanel(false)}>
        {reviewer}
      </aside>
    </>
  ) : (
    <aside className="reviewer-panel" aria-label="Reviewer">
      {reviewer}
    </aside>
  );

  const head = (
    <header className="review-head">
      <button className="icon-btn round" onClick={() => go(null, null)} aria-label="All stacks">
        <Icon name="back" size={20} />
      </button>
      <div className="grow">
        <h1 className="review-title">{stack.title}</h1>
        <p className="tagline">
          {stack.repo} · {stack.source === 'manual' ? 'picked by hand' : `into ${stack.trunk}`}
          {ghStacks.length === 1 ? ` · GitHub stack #${ghStacks[0]}` : ghStacks.length > 1 ? ` · ${ghStacks.length} GitHub stacks` : ''} · {merged} of {counted} merged · {stack.syncError ? <span className="bad">{stack.syncError}</span> : stack.syncing || syncing ? 'refreshing…' : `checked ${ago(stack.syncedAt)}`}
        </p>
      </div>
      {targetSession && !narrow && (
        <button className="btn ghost small session-jump" onClick={() => onOpenSession(targetSession.uid)} title="Jump back to the linked session">
          <AgentLogo id={targetSession.agent} size={14} />
          <span className="ellipsis">{targetSession.title}</span>
        </button>
      )}
      {narrow && (
        <button className={`btn ask ${asking ? 'on' : ''}`} onClick={() => setAsking((v) => !v)} aria-pressed={asking} aria-label="Ask the reviewer" title="Ask the reviewer about the whole stack">
          <Icon name="sparkle" size={16} />
        </button>
      )}
      <Popover label={<Icon name="more" size={18} />} className="icon-btn round" align="right" up={false} title="Stack">
        {(close) => (
          <div className="review-menu">
            <button disabled={syncing} onClick={() => (close(), sync())}>
              {syncing ? 'Refreshing…' : 'Refresh from GitHub'}
            </button>
            {stackItems(close)}
          </div>
        )}
      </Popover>
    </header>
  );

  const layerView = layer && (
    <LayerView
      client={client}
      api={api}
      stack={stack}
      layer={layer}
      findings={findings}
      narrow={narrow}
      menu={layerItems(layer)}
      onBack={() => (narrow ? history.back() : open(null))}
      onStack={(s) => (s ? setStack(s) : load())}
      onRemoved={() => go(null, null)}
      onFindings={loadFindings}
      onNavigate={(next) => go(stack.id, next, { replace: true })}
      onOpenSession={onOpenSession}
      onReviewer={() => setAsking(true)}
      attached={attached.length}
      onDiscuss={discuss}
    />
  );

  if (narrow)
    return layer ? (
      <div className="review-stack layer-mode page phone" data-title={`${layer.role || `#${layer.pr}`} · ${stack.title}`}>
        <div className="review-grid">{layerView}</div>
        {asking && <ReviewerSheet onClose={() => setAsking(false)}>{reviewer}</ReviewerSheet>}
        {handoff}
        {mergeAll}
        {askMerge}
      </div>
    ) : (
      <div className="review-stack page phone" data-title={stack.title}>
        {head}
        <Cockpit stack={stack} alerts={alerts} narrow onStack={(s) => (s ? setStack(s) : load())} onOpen={open} onOpenSession={onOpenSession} onPick={() => go(stack.id, null, { pick: true })} onMerge={() => setMergingAll(true)} />
        {asking && <ReviewerSheet onClose={() => setAsking(false)}>{reviewer}</ReviewerSheet>}
        {handoff}
        {mergeAll}
        {askMerge}
      </div>
    );

  // The same three columns on the overview and on a layer, so the reviewer stays put (and keeps your draft) as you move.
  return (
    <div ref={setBox} className={`review-stack ${layer ? 'layer-mode' : ''}`} data-title={layer ? `${layer.role || `#${layer.pr}`} · ${stack.title}` : stack.title}>
      <div className={`review-grid ${layer ? '' : 'overview'} panel-${shown && !compact ? 'open' : 'closed'}`}>
        {layer ? <SpineColumn stack={stack} pr={pr} onPick={open} /> : <Spine stack={stack} pr={null} onPick={open} />}
        {layer ? (
          layerView
        ) : (
          <div className="review-main">
            {head}
            <Cockpit stack={stack} alerts={alerts} narrow={false} onStack={(s) => (s ? setStack(s) : load())} onOpen={open} onOpenSession={onOpenSession} onPick={() => go(stack.id, null, { pick: true })} onMerge={() => setMergingAll(true)} />
          </div>
        )}
        {side}
      </div>
      {handoff}
      {mergeAll}
      {askMerge}
    </div>
  );
}

/** The Review page: stacks in review and how to start one; a stack, its layers, one layer. */
export default function ReviewPage({ client, state, narrow, onOpenSession }: { client: HostApi; state: State; narrow: boolean; onOpenSession: (uid: string) => void }) {
  const { stack, pr, pick, go } = useRoute();
  if (!stack && pick) return <Compose stack={null} narrow={narrow} onBack={() => go(null, null, { replace: true })} onDone={(s) => go(s.id, null, { replace: true })} />;
  if (!stack) return <StackList state={state} narrow={narrow} onOpen={(id, p) => go(id, p ?? null)} onPick={() => go(null, null, { pick: true })} onOpenSession={onOpenSession} />;
  return <StackScreen key={stack} client={client} state={state} id={stack} pr={pr} pick={pick} narrow={narrow} go={go} onOpenSession={onOpenSession} />;
}
