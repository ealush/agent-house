import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostApi } from '../api.ts';
import { STATUS_WORD, type DiffOut, type Finding, type Layer, type ReviewApi, type Stack } from '../reviewApi.ts';
import { askConfirm, askText, showError } from '../ask.tsx';
import { ConfirmButton } from '../ConfirmButton.tsx';
import { Glide } from '../Glide.tsx';
import { Popover } from '../ModelPicker.tsx';
import { Icon } from '../icons.tsx';
import { Markdown } from '../Markdown.tsx';
import { age, look } from '../agents.ts';
import { ReviewDiff } from './Diff.tsx';
import { FindingsList } from './Findings.tsx';
import { Thread } from './Thread.tsx';
import { DispatchDialog } from './Dispatch.tsx';

type Mode = 'this' | 'since' | 'cumulative';
type Side = 'findings' | 'thread';
type PhoneTab = 'diff' | 'findings' | 'thread';

const toast = (text: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: text }));

function stored<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
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
function Banner({ stack, layer, findings, api, onChanged, onOpenSession, onRestack, onResend }: { stack: Stack; layer: Layer; findings: Finding[]; api: ReviewApi; onChanged: (s?: Stack) => void; onOpenSession: (uid: string) => void; onRestack: () => void; onResend: () => void }) {
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
  if (layer.state !== 'open') return null;
  if (d && (d.state === 'sent' || d.state === 'working'))
    return (
      <div className="layer-band busy">
        <span className="pulse" aria-hidden />
        <span className="grow">
          {d.findings.length ? `${d.findings.length} finding${d.findings.length > 1 ? 's' : ''}` : 'Your message'} with {d.targetTitle ?? 'the agent'} · {d.state === 'working' ? 'working on it' : 'queued'} · sent {age(d.sentAt)} ago
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
        <div className="band-line">
          <Icon name="reload" size={16} />
          <span className="grow">
            {d?.targetTitle ? `${d.targetTitle} pushed` : 'Pushed'}
            {d?.doneAt ? ` ${age(d.doneAt) === 'now' ? 'just now' : `${age(d.doneAt)} ago`}` : ''} · changed since your review<span className="band-sha">{delta}</span>
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
        <span className="grow">{d.targetTitle ?? 'The agent'} finished without pushing {layer.headRef}.</span>
        <button className="btn small" onClick={() => onOpenSession(d.targetUid)}>
          Open session
        </button>
        <button className="btn small" onClick={onResend}>
          Send again
        </button>
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
        <span className="grow">It repeats the commits of the layer merged under it ({stack.mergeMethod}). Its own commits need moving onto {stack.trunk}.</span>
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
}) {
  const [mode, setMode] = useState<Mode>(layer.status === 'rereview' && layer.reviewed ? 'since' : 'this');
  const [diff, setDiff] = useState<DiffOut | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [sideTab, setSideTab] = stored<Side>('ah.review.side', 'findings');
  const [tab, setTab] = useState<PhoneTab>('findings');
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [sending, setSending] = useState<{ ids: number[]; extra: string; kind?: 'restack' } | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [importing, setImporting] = useState(false);
  // The briefing is for a first read; on a re-review, what changed comes first.
  const [briefOpen, setBriefOpen] = useState(layer.status === 'unreviewed' || layer.status === 'changes');
  const [busy, setBusy] = useState(false);
  const label = layer.role || `#${layer.pr}`;
  const rev = layer.current;

  // A new layer starts on what matters for it; a re-review starts on what changed.
  useEffect(() => {
    setMode(layer.status === 'rereview' && layer.reviewed ? 'since' : 'this');
    setBriefOpen(layer.status === 'unreviewed' || layer.status === 'changes');
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
      (d) => live && setDiff(d),
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
    };
  }, [stack.id, layer.pr, rev?.id, !!rev?.summary]);

  const openIds = useMemo(() => new Set(findings.filter((f) => f.ownerPr === layer.pr && f.state === 'open').map((f) => f.id)), [findings, layer.pr]);
  const chosen = [...selected].filter((id) => openIds.has(id));
  const layerFindings = findings.filter((f) => f.ownerPr === layer.pr || f.foundOnPr === layer.pr);
  const proposed = layerFindings.filter((f) => f.state === 'proposed').length;
  const sentWithVerdict = layer.status === 'rereview' && !!rev?.verdict && findings.some((f) => f.ownerPr === layer.pr && f.state === 'sent');
  const gatesOk = layer.gates.length > 0 && layer.gates.every((g) => g.ok);
  const onlyOrder = layer.gates.length > 0 && layer.gates.every((g) => g.ok || g.key === 'order') && !gatesOk;
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
      const ok = await askConfirm({
        title: `Merge ${label} into ${stack.trunk}?`,
        body: `${stack.mergeMethod === 'merge' ? 'A merge commit' : stack.mergeMethod === 'squash' ? 'Squashed' : 'Rebased'}, through GitHub, only if its head is still ${rev?.headSha.slice(0, 7)}. Layers on it will target ${stack.trunk}.${outOfOrder ? ' Out of merge order.' : ''}`,
        confirm: 'Merge',
      });
      if (!ok) return;
      const out = await api.merge(stack.id, layer.pr, outOfOrder);
      onStack(await api.stack(stack.id));
      const next = out.next ? stack.layers.find((l) => l.pr === out.next) : null;
      toast(`Merged ${label}${out.restack.length ? ` · ${out.restack.length} to restack` : ''}${next ? ` · next: ${next.role || `#${next.pr}`}` : ''}`);
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
  const pinDecision = async (seed: string) => {
    const text = await askText({ title: 'Pin a decision', body: 'Every reviewer answer and every message to the agent holds the code to it.', label: 'Decision', value: seed, confirm: 'Pin' });
    if (!text?.trim()) return;
    try {
      onStack(await api.addDecision(stack.id, text.trim(), layer.pr));
      toast('Decision pinned');
    } catch (e) {
      showError(e, "Couldn't pin it");
    }
  };

  // The one button that moves the layer forward (⌘↵).
  let main: { text: string; act: () => void } | null = null;
  if (layer.state === 'open') {
    if (chosen.length) main = { text: `Send ${chosen.length} to ${stack.owner?.agent ? look(stack.owner.agent).name : 'the agent'}`, act: () => setSending({ ids: chosen, extra: '' }) };
    else if (sentWithVerdict) main = { text: 'Accept fixes', act: accept };
    else if (gatesOk) main = { text: 'Merge & next', act: () => void merge() };
    else if (!reviewedNow && rev) main = { text: 'Mark reviewed', act: () => void approve(true) };
  }

  const order = stack.layers.filter((l) => l.state !== 'skipped' && l.state !== 'closed');
  const at = order.findIndex((l) => l.pr === layer.pr);
  const all = stack.layers.map((l) => l.pr);
  const prev = stack.layers[all.indexOf(layer.pr) - 1] ?? null;
  const next = stack.layers[all.indexOf(layer.pr) + 1] ?? null;
  const agent = stack.owner?.agent ? look(stack.owner.agent).name : 'the agent';

  // Second to the main action: on the bar beside it on a desktop, in the ··· menu on a phone.
  const secondaryItems = (close: () => void) => (
    <>
      {narrow && !chosen.length && layer.state === 'open' && <button onClick={() => (close(), setSending({ ids: [], extra: '' }))}>Message {agent}</button>}
      {rev && layer.state === 'open' && reviewedNow && <button onClick={() => (close(), approve(false))}>Take back the review</button>}
      {rev && layer.state === 'open' && !reviewedNow && main?.text !== 'Mark reviewed' && <button onClick={() => (close(), approve(true))}>Mark reviewed</button>}
      {onlyOrder && <button onClick={() => (close(), merge(true))}>Merge out of order</button>}
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
          <span className="ellipsis">{stack.title}</span>
          {at >= 0 && <span className="faint">{` / ${at + 1} of ${order.length}`}</span>}
        </p>
        <div className="layer-title">
          {layer.role && <span className="role-chip">{layer.role}</span>}
          <h2>{layer.title}</h2>
          <a className="pr-link mono" href={layer.url} target="_blank" rel="noreferrer" title="Open on GitHub">
            #{layer.pr}
          </a>
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
          {secondary}
          {main && (
            <ConfirmButton className="btn primary" disabled={busy} onClick={main.act}>
              {main.text}
            </ConfirmButton>
          )}
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
      onResend={() => setSending({ ids: [], extra: layer.needs === 'conflict' ? `Rebase ${layer.headRef} on ${layer.baseRef}, resolve the conflicts, run the tests, and push with --force-with-lease.` : '' })}
    />
  );

  const summary = briefOpen && (
    <section className="briefing" aria-label="Briefing">
      {rev?.summary ? (
        <Markdown text={rev.summary} />
      ) : summarizing ? (
        <p className="hint">Reading the layer for a briefing…</p>
      ) : (
        <p className="hint">{rev ? 'No briefing yet. Add a model under Settings → Subscriptions for one.' : 'Fetching this layer…'}</p>
      )}
      {rev?.summary && (
        <button className="btn ghost small" onClick={() => api.summarize(stack.id, layer.pr, true).then(() => setSummarizing(true)).then(() => onStack(), () => {})} title="Write the briefing again">
          Write it again
        </button>
      )}
    </section>
  );

  const diffPane = (
    <div className="layer-diff">
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
        <button className={`btn ghost small brief-toggle ${briefOpen ? 'on' : ''}`} aria-pressed={briefOpen} onClick={() => setBriefOpen(!briefOpen)}>
          <Icon name="files" size={15} /> Briefing{summarizing && !rev?.summary ? '…' : ''}
        </button>
      </div>
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

  const findingsPane = (
    <FindingsList
      api={api}
      stackId={stack.id}
      layer={layer}
      layers={stack.layers}
      findings={findings}
      selected={selected}
      setSelected={setSelected}
      onChanged={() => {
        onFindings();
        onStack();
      }}
      onImport={importThreads}
      importing={importing}
    />
  );

  const threadPane = (
    <Thread
      client={client}
      api={api}
      stackId={stack.id}
      pr={layer.pr}
      layers={stack.layers}
      onSend={(text) => setSending({ ids: [], extra: text })}
      onDecision={pinDecision}
      onChanged={() => {
        onFindings();
        onStack();
      }}
    />
  );

  const side = (
    <aside className="layer-side">
      <Seg<Side>
        label="Side"
        value={sideTab}
        onChange={setSideTab}
        options={[
          ['findings', <>Findings{layer.open + proposed ? <span className="count"> {layer.open + proposed}</span> : null}</>],
          ['thread', 'Reviewer'],
        ]}
      />
      <div className="side-pane">{sideTab === 'findings' ? findingsPane : threadPane}</div>
      {sideTab === 'findings' && chosen.length > 0 && (
        <footer className="side-foot">
          <span className="grow hint">
            {chosen.length} selected{layer.state === 'open' && stack.layers.some((l) => l.baseRef === layer.headRef && l.state === 'open') ? ' · the layers above restack after the fix' : ''}
          </span>
          <button className="btn ghost small" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </footer>
      )}
    </aside>
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
            ['findings', <>Findings{layer.open + proposed ? <span className="count"> {layer.open + proposed}</span> : null}</>],
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
          {tab === 'thread' && threadPane}
        </div>
        <footer className="merge-bar layer-bar">
          {nav(prev, 'prev', true)}
          {main ? (
            <button className="btn primary" disabled={busy} onClick={main.act}>
              {main.text}
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
      <div className="layer-body">
        <div className="layer-main">
          {diffPane}
          {layer.state === 'open' && <Gates layer={layer} />}
        </div>
        {side}
      </div>
      {dialog}
    </div>
  );
}
