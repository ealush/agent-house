import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostApi, Subscription } from '../api.ts';
import { attachKey, STATUS_WORD, type Attachment, type DiffOut, type Finding, type Layer, type ReviewApi, type Stack } from '../reviewApi.ts';
import { askConfirm, askText, showError } from '../ask.tsx';
import { ConfirmButton } from '../ConfirmButton.tsx';
import { Glide } from '../Glide.tsx';
import { Popover } from '../ModelPicker.tsx';
import { Icon } from '../icons.tsx';
import { Markdown } from '../Markdown.tsx';
import { SubscriptionPicker } from '../SubscriptionPicker.tsx';
import { age, look } from '../agents.ts';
import { ReviewDiff } from './Diff.tsx';
import { FindingsList } from './Findings.tsx';
import { DispatchDialog } from './Dispatch.tsx';
import { GitHubText } from './GitHubText.tsx';

type Mode = 'this' | 'since' | 'cumulative';
type PhoneTab = 'diff' | 'findings' | 'thread';

const toast = (text: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: text }));
const when = (t: number) => (age(t) === 'now' ? 'just now' : `${age(t)} ago`);

/** A choice kept in this browser (a fold, a tab), read once. */
export function stored<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || fallback;
    } catch {
      return fallback;
    }
  });
  return [
    v,
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(key, next);
      } catch {}
    },
  ];
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, React.ReactNode][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      <Glide match=".on" className="thumb" />
      {options.map(([k, text]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** One thing to know right now about the layer, with the action that goes with it. */
function Banner({ stack, layer, findings, api, since, onChanged, onOpenSession, onRestack, onResend }: { stack: Stack; layer: Layer; findings: Finding[]; api: ReviewApi; since: { lines: number; files: number } | null; onChanged: (s?: Stack) => void; onOpenSession: (uid: string) => void; onRestack: () => void; onResend: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<Stack | void>, what: string) => {
    setBusy(true);
    try {
      onChanged((await fn()) ?? undefined);
    } catch (e) {
      showError(e, what);
    } finally {
      setBusy(false);
    }
  };
  const d = layer.dispatch;
  const verdict = layer.current?.verdict;
  const who = d?.targetAgent ? look(d.targetAgent).name : (d?.targetTitle ?? 'The agent');
  if (layer.state !== 'open') return null;
  if (d && (d.state === 'sent' || d.state === 'working'))
    return (
      <div className="layer-band busy">
        <span className="pulse" aria-hidden />
        <span className="grow">
          {d.findings.length ? `${d.findings.length} finding${d.findings.length > 1 ? 's' : ''}` : 'Your message'} with {who} · {d.state === 'working' ? 'working on it' : 'queued'} · sent {when(d.sentAt)}
        </span>
        <button className="btn small" onClick={() => onOpenSession(d.targetUid)}>
          Open session
        </button>
      </div>
    );
  if (layer.status === 'rereview') {
    const delta = layer.current && layer.reviewed ? ` (${layer.reviewed.headSha.slice(0, 7)} → ${layer.current.headSha.slice(0, 7)})` : '';
    return (
      <div className="layer-band needs">
        <div className="band-line" title={delta ? `Head ${delta.trim().replace(/[()]/g, '')}` : undefined}>
          <Icon name="reload" size={16} />
          <span className="grow">
            {d ? `${who} pushed fixes` : 'Pushed'}
            {d?.doneAt ? ` ${when(d.doneAt)}` : ''} · {since ? `${since.lines} line${since.lines === 1 ? '' : 's'} in ${since.files} file${since.files === 1 ? '' : 's'} since your review` : 'changed since your review'}
          </span>
          {verdict && <span className="hint">Checked by the reviewer</span>}
        </div>
        {verdict?.summary && <p className="band-note">{verdict.summary}</p>}
        {verdict && (verdict.items.length > 0 || verdict.unrequested.length > 0) && (
          <ul className="verdicts">
            {verdict.items.map((i) => (
              <li key={i.id} className={`v-${i.verdict}`} title={i.evidence || undefined}>
                <span className="v-mark" aria-hidden>
                  {i.verdict === 'addressed' ? '✓' : i.verdict === 'partly' ? '◐' : '✗'}
                </span>
                {findings.find((f) => f.id === i.id)?.title ?? 'A finding'}
                <span className="sr-only">: {i.verdict === 'addressed' ? 'addressed' : i.verdict === 'partly' ? 'partly addressed' : 'not addressed'}</span>
                {i.verdict !== 'addressed' && <span className="v-word"> · {i.verdict === 'partly' ? 'partly' : 'not fixed'}</span>}
              </li>
            ))}
            {verdict.unrequested.map((u, n) => (
              <li key={`u${n}`} className="v-extra" title={u.path ? `${u.path}${u.line ? `:${u.line}` : ''}` : undefined}>
                <span className="v-mark" aria-hidden>
                  !
                </span>
                Unrequested: {u.title}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (d?.state === 'no-push')
    return (
      <div className="layer-band needs">
        <span className="grow">
          {who} finished without pushing {layer.headRef}.
        </span>
        <button className="btn small" onClick={() => onOpenSession(d.targetUid)}>
          Open session
        </button>
        <button className="btn small" onClick={onResend}>
          Send again
        </button>
      </div>
    );
  if (layer.needs === 'merging' || layer.needs === 'queued')
    return (
      <div className="layer-band">
        <span className="grow">{layer.needs === 'queued' ? `In ${stack.trunk}'s merge queue. It merges when the queue gets to it.` : 'GitHub is merging it. ah sees it land.'}</span>
      </div>
    );
  if (layer.needs === 'retarget')
    return (
      <div className="layer-band needs">
        <span className="grow">
          The layer under it merged, but it still targets <span className="mono">{layer.baseRef}</span>.
        </span>
        <button className="btn small" disabled={busy} onClick={() => act(() => api.retarget(stack.id, layer.pr), "Couldn't retarget")}>
          Target {stack.trunk}
        </button>
      </div>
    );
  if (layer.needs === 'restack')
    return (
      <div className="layer-band needs">
        <span className="grow">
          {layer.ghStack !== null ? (
            <>
              It no longer sits on top of <span className="mono">{layer.baseRef}</span>, and GitHub merges a stack only when each branch is on the one under it.
            </>
          ) : (
            `It repeats the commits of the layer merged under it (${stack.mergeMethod}). Its own commits need moving onto ${stack.trunk}.`
          )}
        </span>
        <button className="btn small" onClick={onRestack}>
          Ask the agent to restack
        </button>
      </div>
    );
  if (layer.needs === 'conflict')
    return (
      <div className="layer-band needs">
        <span className="grow">Conflicts with {layer.baseRef}.</span>
        <button className="btn small" onClick={onResend}>
          Ask the agent to rebase
        </button>
      </div>
    );
  if (layer.draft)
    return (
      <div className="layer-band">
        <span className="grow">Draft on GitHub.</span>
        <button className="btn small" disabled={busy} onClick={() => act(() => api.ready(stack.id, layer.pr), "Couldn't mark it ready")}>
          Mark ready
        </button>
      </div>
    );
  return null;
}

/** What merging waits on, as a row of marks: green when it holds. */
function Gates({ layer }: { layer: Layer }) {
  if (!layer.gates.length) return null;
  return (
    <ul className="gates" aria-label="Before merging">
      {layer.gates.map((g) => (
        <li key={g.key} className={g.ok ? 'ok' : 'no'} title={g.detail ?? g.label}>
          <span className="g-mark" aria-hidden />
          <span>{g.detail ?? g.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One layer: what it is, what to know now, its patch, its findings and the
 * reviewer, and the one button that moves it forward.
 */
export function LayerView({
  client,
  api,
  stack,
  layer,
  findings,
  narrow,
  menu,
  onBack,
  onStack,
  onFindings,
  onNavigate,
  onOpenSession,
  reviewer,
  onDiscuss,
}: {
  client: HostApi;
  api: ReviewApi;
  stack: Stack;
  layer: Layer;
  findings: Finding[];
  narrow: boolean;
  /** The layer's own menu items (label, order, skip, take out), from the stack page. */
  menu: (close: () => void) => React.ReactNode;
  onBack: () => void;
  onStack: (s?: Stack) => void;
  onFindings: () => void;
  onNavigate: (pr: number | null) => void;
  onOpenSession: (uid: string) => void;
  /** The stack's reviewer conversation: the phone's Reviewer tab (on a desktop it sits beside the layer). */
  reviewer: React.ReactNode;
  /** Bring something to the reviewer's conversation. */
  onDiscuss: (a: Attachment) => void;
}) {
  const [mode, setMode] = useState<Mode>(layer.status === 'rereview' && layer.reviewed ? 'since' : 'this');
  const [diff, setDiff] = useState<DiffOut | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [findingsOpen, setFindingsOpen] = stored<'open' | 'closed'>('ah.review.findings', 'open');
  const [tab, setTab] = useState<PhoneTab>('findings');
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [sending, setSending] = useState<{ ids: number[]; extra: string; kind?: 'restack' } | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  /** Who writes briefings and re-checks: Settings → Subscriptions' choice, else the active one. */
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [summaryId, setSummaryId] = useState<string | null>(null);
  useEffect(() => {
    client.subscriptions().then(setSubs, () => {});
    api.settings().then((s) => setSummaryId(s.summaryId), () => {});
  }, []);
  const [importing, setImporting] = useState(false);
  // Above the diff, one card at a time: the PR's description from GitHub, or the briefing. The
  // briefing is for a first read; on a re-review, what changed comes first.
  const [card, setCard] = useState<'description' | 'briefing' | null>(layer.status === 'unreviewed' || layer.status === 'changes' ? 'briefing' : null);
  const briefOpen = card === 'briefing';
  const [desc, setDesc] = useState<{ pr: number; body: string } | { pr: number; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // How much changed since your review, counted from the since-review patch once it's loaded.
  const [since, setSince] = useState<{ pr: number; lines: number; files: number } | null>(null);
  const label = layer.role || `#${layer.pr}`;
  const rev = layer.current;

  // A new layer starts on what matters for it; a re-review starts on what changed.
  useEffect(() => {
    setMode(layer.status === 'rereview' && layer.reviewed ? 'since' : 'this');
    setCard(layer.status === 'unreviewed' || layer.status === 'changes' ? 'briefing' : null);
    setSelected(new Set());
    setTab('findings');
  }, [layer.pr]);

  useEffect(() => {
    if (layer.status === 'rereview' && layer.reviewed) setMode('since');
  }, [layer.status]);

  useEffect(() => {
    if (!rev) return;
    let live = true;
    setDiffError(null);
    const m = mode === 'since' && !layer.reviewed ? 'this' : mode;
    api.diff(stack.id, layer.pr, m).then(
      (d) => {
        if (!live) return;
        setDiff(d);
        if (m === 'since' && d.kind === 'patch') {
          const lines = d.text.split('\n');
          setSince({ pr: layer.pr, files: lines.filter((x) => x.startsWith('diff --git ')).length, lines: lines.filter((x) => /^[+-](?![+-]{2} )/.test(x)).length });
        }
      },
      (e) => live && setDiffError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [stack.id, layer.pr, mode, rev?.id, layer.reviewed?.id]);

  // The briefing is made once per patch, in the background; the next layer's is prepared too.
  useEffect(() => {
    if (!rev || rev.summary || layer.state !== 'open') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    api.summarize(stack.id, layer.pr).then((r) => {
      if (!live || !r.started) return;
      setSummarizing(true);
      const poll = () =>
        api.busy(stack.id, layer.pr).then((b) => {
          if (!live) return;
          if (b.summarizing) timer = setTimeout(poll, 2000);
          else {
            setSummarizing(false);
            onStack();
          }
        }, () => live && setSummarizing(false));
      timer = setTimeout(poll, 2000);
    }, () => {});
    const order = stack.layers.filter((l) => l.state === 'open').map((l) => l.pr);
    const next = order[order.indexOf(layer.pr) + 1];
    if (next) void api.summarize(stack.id, next).catch(() => {});
    return () => {
      live = false;
      clearTimeout(timer);
      // Its poll stops here, so it can't clear the flag; this run's answer (a briefing, another layer) does.
      setSummarizing(false);
    };
  }, [stack.id, layer.pr, rev?.id, !!rev?.summary]);

  // Findings left open on layers that merged are fixed on the next open one.
  const followups = useMemo(() => (layer.followups ? findings.filter((f) => f.state === 'open' && stack.layers.find((l) => l.pr === f.ownerPr)?.state === 'merged') : []), [findings, layer.followups, stack.layers]);
  const openIds = useMemo(() => new Set([...findings.filter((f) => f.ownerPr === layer.pr && f.state === 'open'), ...followups].map((f) => f.id)), [findings, followups, layer.pr]);
  const chosen = [...selected].filter((id) => openIds.has(id));
  const layerFindings = findings.filter((f) => f.ownerPr === layer.pr || f.foundOnPr === layer.pr);
  const proposed = layerFindings.filter((f) => f.state === 'proposed').length;
  const count = layer.open + proposed + followups.length;
  const above = stack.layers.filter((l) => l.baseRef === layer.headRef && l.state === 'open');
  const sentWithVerdict = layer.status === 'rereview' && !!rev?.verdict && findings.some((f) => f.ownerPr === layer.pr && f.state === 'sent');
  const gatesOk = layer.gates.length > 0 && layer.gates.every((g) => g.ok);
  const onlyOrder = layer.gates.length > 0 && layer.gates.every((g) => g.ok || g.key === 'order') && !gatesOk;
  // In a GitHub stack, GitHub merges the layers under it along with it.
  const under = layer.ghStack !== null ? stack.layers.filter((l) => l.ghStack === layer.ghStack && (l.ghPos ?? 0) < (layer.ghPos ?? 0) && l.state === 'open') : [];
  const names = (ls: Layer[]) => ls.map((l) => l.role || `#${l.pr}`).join(', ');
  const reviewedNow = layer.approved && layer.samePatch;

  const run = async (fn: () => Promise<void>, what: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      showError(e, what);
    } finally {
      setBusy(false);
    }
  };

  const approve = (on: boolean) => run(async () => onStack(await api.approve(stack.id, layer.pr, on)), "Couldn't mark it reviewed");
  const accept = () =>
    run(async () => {
      onStack(await api.accept(stack.id, layer.pr));
      onFindings();
      toast('Fixes accepted');
    }, "Couldn't accept the fixes");
  const merge = (outOfOrder = false) =>
    run(async () => {
      const how = stack.mergeMethod === 'merge' ? 'A merge commit' : stack.mergeMethod === 'squash' ? 'Squashed' : 'Rebased';
      const ok = await askConfirm(
        layer.ghStack !== null
          ? {
              title: under.length ? `Merge ${label} and the ${under.length === 1 ? 'layer' : `${under.length} layers`} under it into ${stack.trunk}?` : `Merge ${label} into ${stack.trunk}?`,
              body: `${how}, through GitHub's stack merge, only if its head is still ${rev?.headSha.slice(0, 7)}.${under.length ? ` ${names(under)} ${under.length === 1 ? 'lands' : 'land'} with it, all or none.` : ''} GitHub retargets and rebases the layers above it.`,
              confirm: under.length ? `Merge ${under.length + 1}` : 'Merge',
            }
          : {
              title: `Merge ${label} into ${stack.trunk}?`,
              body: `${how}, through GitHub, only if its head is still ${rev?.headSha.slice(0, 7)}. Layers on it will target ${stack.trunk}.${outOfOrder ? ' Out of merge order.' : ''}`,
              confirm: 'Merge',
            },
      );
      if (!ok) return;
      const out = await api.merge(stack.id, layer.pr, outOfOrder);
      onStack(await api.stack(stack.id));
      const next = out.next ? stack.layers.find((l) => l.pr === out.next) : null;
      if (out.waiting) toast(out.waiting === 'queue' ? `${label} is in the merge queue` : `GitHub is merging ${label}`);
      else toast(`Merged ${out.merged.length > 1 ? `${out.merged.length} layers` : label}${out.restack.length ? ` · ${out.restack.length} to restack` : ''}${next ? ` · next: ${next.role || `#${next.pr}`}` : ''}`);
      onNavigate(out.next);
    }, "Couldn't merge");
  const importThreads = async () => {
    setImporting(true);
    try {
      const r = await api.importThreads(stack.id, layer.pr);
      toast(r.added ? `${r.added} thread${r.added > 1 ? 's' : ''} from GitHub` : 'No new threads on GitHub');
      onFindings();
    } catch (e) {
      showError(e, "Couldn't read GitHub's threads");
    } finally {
      setImporting(false);
    }
  };
  const addFinding = async (f: { path: string; line: number; title: string; body: string; severity: string }) => {
    try {
      await api.addFinding(stack.id, { ownerPr: layer.pr, title: f.title, body: f.body, severity: f.severity, path: f.path, lineStart: f.line });
      onFindings();
      onStack();
    } catch (e) {
      showError(e, "Couldn't add the finding");
      throw e;
    }
  };
  const discuss = (f: Finding) => {
    const ctx = { kind: 'finding' as const, id: f.id };
    onDiscuss({ ctx, label: f.title, key: attachKey(ctx) });
    if (narrow) setTab('thread');
  };

  // The one button that moves the layer forward (⌘↵).
  const agent = stack.owner?.agent ? look(stack.owner.agent).name : 'the agent';
  // The flow's next step sits in the header; sending the findings you picked sits under them.
  const send = chosen.length && layer.state === 'open' ? { text: `Send ${chosen.length} finding${chosen.length === 1 ? '' : 's'} to ${agent}`, act: () => setSending({ ids: chosen, extra: '' }) } : null;
  let main: { text: string; act: () => void } | null = null;
  if (layer.state === 'open') {
    if (sentWithVerdict) main = { text: 'Accept fixes', act: accept };
    else if (gatesOk) main = { text: 'Merge & next', act: () => void merge() };
    else if (!reviewedNow && rev) main = { text: 'Mark reviewed', act: () => void approve(true) };
  }

  const order = stack.layers.filter((l) => l.state !== 'skipped' && l.state !== 'closed');
  const at = order.findIndex((l) => l.pr === layer.pr);
  const all = stack.layers.map((l) => l.pr);
  const prev = stack.layers[all.indexOf(layer.pr) - 1] ?? null;
  const next = stack.layers[all.indexOf(layer.pr) + 1] ?? null;

  // Second to the main action: on the bar beside it on a desktop, in the ··· menu on a phone.
  const secondaryItems = (close: () => void) => (
    <>
      {narrow && !chosen.length && layer.state === 'open' && <button onClick={() => (close(), setSending({ ids: [], extra: '' }))}>Message {agent}</button>}
      {rev && layer.state === 'open' && reviewedNow && <button onClick={() => (close(), approve(false))}>Take back the review</button>}
      {rev && layer.state === 'open' && !reviewedNow && main?.text !== 'Mark reviewed' && <button onClick={() => (close(), approve(true))}>Mark reviewed</button>}
      {onlyOrder && <button onClick={() => (close(), merge(true))}>{under.length ? `Merge with ${names(under)}` : 'Merge out of order'}</button>}
      <a href={layer.url} target="_blank" rel="noreferrer" onClick={close}>
        Open on GitHub
      </a>
    </>
  );
  const secondary = layer.state === 'open' && !chosen.length && (
    <button className="btn" onClick={() => setSending({ ids: [], extra: '' })} title="Write to the agent that owns this stack">
      Message agent
    </button>
  );

  const nav = (l: Layer | null, dir: 'prev' | 'next', round = false) => (
    <button className={round ? 'icon-btn round' : `btn nav-btn ${dir}`} disabled={!l} onClick={() => onNavigate(l?.pr ?? null)} aria-label={l ? `${dir === 'prev' ? 'Previous' : 'Next'} layer, ${l.role || `#${l.pr}`}` : dir === 'prev' ? 'No earlier layer' : 'No later layer'} title={l ? `${l.role || `#${l.pr}`} · ${l.title} (${dir === 'prev' ? 'k' : 'j'})` : undefined}>
      <span className={dir === 'next' ? 'fwd' : ''} aria-hidden>
        <Icon name="back" size={16} />
      </span>
      {!round && l && <span className="mono">{l.role || `#${l.pr}`}</span>}
    </button>
  );

  const more = (close: () => void) => (
    <div className="review-menu">
      {secondaryItems(close)}
      {menu(close)}
    </div>
  );

  const head = (
    <header className="layer-head">
      <button className="icon-btn round" onClick={onBack} aria-label="Stack overview">
        <Icon name="back" size={20} />
      </button>
      <div className="grow layer-id">
        <p className="crumb">
          {narrow ? (
            <span>
              {at >= 0 ? `${at + 1} of ${order.length} · ` : ''}#{layer.pr}
            </span>
          ) : (
            <>
              <span className="ellipsis">{stack.title}</span>
              {at >= 0 && <span className="faint">{` / ${at + 1} of ${order.length}`}</span>}
            </>
          )}
        </p>
        <div className="layer-title">
          {layer.role && <span className="role-chip">{layer.role}</span>}
          <h2>{layer.title}</h2>
          {!narrow && (
            <a className="pr-link mono" href={layer.url} target="_blank" rel="noreferrer" title="Open on GitHub">
              #{layer.pr}
            </a>
          )}
        </div>
      </div>
      {!narrow && (
        <>
          <div className="nav-pair">
            {nav(prev, 'prev')}
            {nav(next, 'next')}
          </div>
          <Popover label={<Icon name="more" size={18} />} className="icon-btn round" align="right" up={false} title="Layer">
            {more}
          </Popover>
          <span className="head-sep" aria-hidden />
          {secondary}
          {main &&
            (send ? (
              <button className="btn primary" disabled={busy} onClick={main.act}>
                {main.text}
              </button>
            ) : (
              <ConfirmButton className="btn primary" disabled={busy} onClick={main.act}>
                {main.text}
              </ConfirmButton>
            ))}
        </>
      )}
    </header>
  );

  const banner = (
    <Banner
      stack={stack}
      layer={layer}
      findings={findings}
      api={api}
      onChanged={(s) => onStack(s)}
      onOpenSession={onOpenSession}
      onRestack={() => setSending({ ids: [], extra: '', kind: 'restack' })}
      since={since?.pr === layer.pr ? since : null}
      onResend={() => setSending({ ids: [], extra: layer.needs === 'conflict' ? `Rebase ${layer.headRef} on ${layer.baseRef}, resolve the conflicts, run the tests, and push with --force-with-lease.` : '' })}
    />
  );

  /** Write the briefing again (another model, or a fresh read) and watch it finish. */
  const rewrite = () =>
    api.summarize(stack.id, layer.pr, true).then(() => {
      setSummarizing(true);
      const poll = () =>
        api.busy(stack.id, layer.pr).then(
          (b) => {
            if (b.summarizing) return void setTimeout(poll, 2000);
            setSummarizing(false);
            onStack();
          },
          () => setSummarizing(false),
        );
      setTimeout(poll, 2000);
    });

  // The description is read when it's opened, fresh from GitHub.
  useEffect(() => {
    if (card !== 'description' || desc?.pr === layer.pr) return;
    let live = true;
    const pr = layer.pr;
    api.description(stack.id, pr).then(
      (d) => live && setDesc({ pr, body: d.body }),
      (e) => live && setDesc({ pr, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [card, layer.pr, stack.id]);

  const description = card === 'description' && (
    <section className="briefing pr-description" aria-label="Description">
      {desc?.pr !== layer.pr ? (
        <p className="hint">Reading the description on GitHub…</p>
      ) : 'error' in desc ? (
        <p className="hint">Couldn't read it: {desc.error}</p>
      ) : desc.body.trim() ? (
        <GitHubText text={desc.body} image={(src) => api.imageUrl(stack.id, src)} />
      ) : (
        <p className="hint">This pull request has no description.</p>
      )}
      <div className="briefing-foot">
        <a className="btn ghost small" href={layer.url} target="_blank" rel="noreferrer">
          #{layer.pr} on GitHub <Icon name="external" size={13} />
        </a>
      </div>
    </section>
  );

  const summary = briefOpen && (
    <section className="briefing" aria-label="Briefing">
      {rev?.summary ? (
        <>
          {summarizing && <p className="hint">Writing it again…</p>}
          <Markdown text={rev.summary} />
        </>
      ) : summarizing ? (
        <p className="hint">Reading the layer for a briefing…</p>
      ) : (
        <p className="hint">{rev ? 'No briefing yet. Add a model under Settings → Subscriptions for one.' : 'Fetching this layer…'}</p>
      )}
      {rev && subs.length > 0 && (
        <div className="briefing-foot">
          <SubscriptionPicker
            subs={subs}
            value={summaryId}
            up={false}
            title="Briefings and re-checks"
            note="For every stack; rewrites this one"
            disabled={summarizing}
            onPick={(id) =>
              api
                .setSummaryModel(id)
                .then((s) => setSummaryId(s.summaryId))
                .then(rewrite)
                .catch((e) => showError(e, "Couldn't switch the model"))
            }
          />
          {rev.summary && !summarizing && (
            <button className="btn ghost small" onClick={() => void rewrite().catch(() => {})} title="Write the briefing again">
              Write it again
            </button>
          )}
        </div>
      )}
    </section>
  );

  const findingsPane = (
    <FindingsList
      api={api}
      stackId={stack.id}
      layer={layer}
      layers={stack.layers}
      findings={findings}
      followups={followups}
      selected={selected}
      setSelected={setSelected}
      onChanged={() => {
        onFindings();
        onStack();
      }}
      onImport={importThreads}
      importing={importing}
      onDiscuss={discuss}
    />
  );

  // Above the diff on a desktop: the layer's findings, folded to a line when you want the room, and sending the ones you picked.
  const sendFoot = chosen.length > 0 && (
    <footer className="side-foot">
      <span className="side-why">
        <span className="grow hint">
          {chosen.length} selected{above.length ? ` · ${above.map((l) => l.role || `#${l.pr}`).join(', ')} restack${above.length === 1 ? 's' : ''} after the fix` : ''}
        </span>
        <button className="btn ghost small" onClick={() => setSelected(new Set())}>
          Clear
        </button>
      </span>
      {send && (
        <ConfirmButton className="btn send" disabled={busy} onClick={send.act}>
          {send.text}
        </ConfirmButton>
      )}
    </footer>
  );
  const findingsSection = (
    <section className={`layer-findings ${findingsOpen === 'open' ? 'open' : ''}`} aria-label="Findings">
      <button className="findings-fold" aria-expanded={findingsOpen === 'open'} onClick={() => setFindingsOpen(findingsOpen === 'open' ? 'closed' : 'open')}>
        <span className="fold-mark" aria-hidden>
          <Icon name="back" size={14} />
        </span>
        <span className="findings-word">Findings</span>
        {count > 0 && <span className="count">{count}</span>}
        <span className="hint grow">{findingsOpen === 'open' ? '' : count ? (layer.open ? `${layer.open} open` : proposed ? `${proposed} proposed` : `${followups.length} follow-up${followups.length === 1 ? '' : 's'}`) : 'None yet'}</span>
      </button>
      {findingsOpen === 'open' && (
        <>
          {findingsPane}
          {sendFoot}
        </>
      )}
    </section>
  );

  const diffPane = (
    <div className="layer-diff">
      {!narrow && findingsSection}
      <div className="diff-bar">
        <Seg<Mode>
          label="Diff"
          value={mode}
          onChange={setMode}
          options={[...(layer.reviewed ? ([['since', 'Since review']] as [Mode, string][]) : []), ['this', 'This PR'], ['cumulative', `From ${stack.trunk}`]]}
        />
        {rev && !narrow && (
          <span className="diff-meta">
            {rev.files} file{rev.files === 1 ? '' : 's'} <span className="add-n">+{rev.additions}</span> <span className="del-n">−{rev.deletions}</span>
            <span className="mono faint branchline" title={`${layer.headRef} into ${layer.baseRef}`}>
              {layer.headRef} → {layer.baseRef}
            </span>
          </span>
        )}
        <span className="spacer" />
        {diff?.truncated && <span className="hint">First 400 KB</span>}
        <span className="card-toggles">
          <button className={`btn ghost small brief-toggle ${card === 'description' ? 'on' : ''}`} aria-pressed={card === 'description'} title="The pull request's description, from GitHub" onClick={() => setCard(card === 'description' ? null : 'description')}>
            <Icon name="queue" size={15} /> Description
          </button>
          <button className={`btn ghost small brief-toggle ${briefOpen ? 'on' : ''}`} aria-pressed={briefOpen} title="What the layer does and where to look, written for this review" onClick={() => setCard(briefOpen ? null : 'briefing')}>
            <Icon name="sparkle" size={15} /> Briefing{summarizing && !rev?.summary ? '…' : ''}
          </button>
        </span>
      </div>
      {description}
      {summary}
      {diffError ? (
        <p className="panel-msg">{diffError}</p>
      ) : !diff ? (
        <p className="panel-msg">Loading…</p>
      ) : diff.kind === 'range' ? (
        <>
          <p className="hint range-note">Rebased since your review: git range-diff pairs the old and new commits and shows how each one's patch changed.</p>
          <pre className="range-diff">{diff.text || 'No changes.'}</pre>
        </>
      ) : mode === 'since' && !diff.text ? (
        <p className="panel-msg">Nothing changed since your review.</p>
      ) : (
        <ReviewDiff patch={diff.text} findings={layerFindings} onFile={mode === 'cumulative' ? undefined : addFinding} />
      )}
    </div>
  );

  const dialog = sending && (
    <DispatchDialog
      api={api}
      stack={stack}
      layer={layer}
      findingIds={sending.ids}
      extra={sending.extra}
      kind={sending.kind}
      onClose={() => setSending(null)}
      onSent={(outcome, to) => {
        setSelected(new Set());
        toast(outcome === 'queued' ? `Queued for ${to}` : `Sent to ${to}`);
        onStack();
        onFindings();
      }}
    />
  );

  if (narrow)
    return (
      <div className="layer phone">
        {head}
        <Seg<PhoneTab>
          label="Layer"
          value={tab}
          onChange={setTab}
          options={[
            ['findings', <>Findings{count ? <span className="count"> {count}</span> : null}</>],
            ['diff', 'Diff'],
            ['thread', 'Reviewer'],
          ]}
        />
        <div className="layer-tab">
          {tab === 'findings' && (
            <>
              {banner}
              {findingsPane}
              <Gates layer={layer} />
            </>
          )}
          {tab === 'diff' && diffPane}
          {tab === 'thread' && <div className="layer-reviewer">{reviewer}</div>}
        </div>
        <footer className="merge-bar layer-bar">
          {nav(prev, 'prev', true)}
          {send ?? main ? (
            <button className="btn primary" disabled={busy} onClick={(send ?? main)!.act}>
              {(send ?? main)!.text}
            </button>
          ) : (
            <span className="grow hint bar-why">{layer.state === 'open' ? (layer.gates.find((g) => !g.ok)?.detail ?? layer.gates.find((g) => !g.ok)?.label ?? '') : STATUS_WORD[layer.status]}</span>
          )}
          <Popover label={<Icon name="more" size={18} />} className="icon-btn round" align="right" up title="More">
            {more}
          </Popover>
          {nav(next, 'next', true)}
        </footer>
        {dialog}
      </div>
    );

  return (
    <div className="layer">
      {head}
      {banner}
      <div className="layer-main">
        {diffPane}
        {layer.state === 'open' && <Gates layer={layer} />}
      </div>
      {dialog}
    </div>
  );
}
