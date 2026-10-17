// Picking pull requests for a stack: tick open PRs in a project, put them in
// review-and-merge order, start. The PRs needn't sit on each other's branches:
// a stack you pick is reviewed and merged one at a time, in your order, the way
// a stack of diffs lands. PRs that do sit on each other are grouped, so taking a
// whole chain is one click, and ah warns when a PR would come before its base.
// A stack on GitHub is its own group: reviewing it follows GitHub's stack.
import { useEffect, useMemo, useRef, useState } from 'react';
import { reviewApi, reviewHash, type Candidate, type CandidateTree, type Candidates, type Stack } from '../reviewApi.ts';
import { showError } from '../ask.tsx';
import { ConfirmButton } from '../ConfirmButton.tsx';
import { Icon } from '../icons.tsx';
import { Sheet } from '../sheet.tsx';

const api = reviewApi();
const ROOT_KEY = 'ah.review.root';

/** The project last picked from, so New stack opens where you were. */
export function rememberRoot(root: string) {
  try {
    localStorage.setItem(ROOT_KEY, root);
  } catch {}
}
function lastRoot(): string {
  try {
    return localStorage.getItem(ROOT_KEY) ?? '';
  } catch {
    return '';
  }
}

type Group = { key: string; label: string; chain: boolean; native?: number; rows: { pr: Candidate; depth: number }[] };

/** Stacks on GitHub first, then chains (a PR with others built on it), then single PRs by the branch they target. */
function groups(c: Candidates, all: Map<number, Candidate>): Group[] {
  const onGitHub = new Set(c.native.flatMap((n) => n.prs));
  const native: Group[] = c.native.map((n) => ({
    key: `gh-${n.number}`,
    label: `GitHub stack #${n.number}`,
    chain: true,
    native: n.number,
    rows: n.prs.filter((x) => all.has(x)).map((x, i) => ({ pr: all.get(x)!, depth: i })),
  }));
  const flat = (t: CandidateTree, depth: number, out: { pr: Candidate; depth: number }[]) => {
    if (!onGitHub.has(t.pr.number)) out.push({ pr: t.pr, depth });
    for (const ch of t.children) flat(ch, depth + 1, out);
    return out;
  };
  const chains: Group[] = c.trees
    .filter((t) => t.children.length)
    .map((t) => ({ key: `chain-${t.pr.number}`, label: `Stacked on #${t.pr.number}`, chain: true, rows: flat(t, 0, []) }));
  const single = c.trees.filter((t) => !t.children.length && !onGitHub.has(t.pr.number));
  const bases = [...new Set(single.map((t) => t.pr.baseRefName))].sort((a, b) => (a === c.trunk ? -1 : b === c.trunk ? 1 : a.localeCompare(b)));
  const loose: Group[] = bases.map((b) => ({ key: `on-${b}`, label: `On ${b}`, chain: false, rows: single.filter((t) => t.pr.baseRefName === b).map((t) => ({ pr: t.pr, depth: 0 })) }));
  return [...native, ...chains, ...loose];
}

/** Bases before what's built on them; otherwise the order you gave. */
function byBases(order: number[], all: Map<number, Candidate>): number[] {
  const heads = new Map(order.map((n) => [all.get(n)!.headRefName, n]));
  const out: number[] = [];
  const visit = (n: number, seen: Set<number>) => {
    if (out.includes(n) || seen.has(n)) return;
    seen.add(n);
    const base = heads.get(all.get(n)!.baseRefName);
    if (base !== undefined) visit(base, seen);
    out.push(n);
  };
  for (const n of order) visit(n, new Set());
  return out;
}

function Row({ pr, depth, on, onToggle, pos }: { pr: Candidate; depth: number; on: boolean; onToggle: () => void; pos: number }) {
  return (
    <li>
      <label className={`pick-row ${on ? 'on' : ''}`} style={{ '--depth': depth } as React.CSSProperties}>
        <span className="pick">
          <input type="checkbox" checked={on} onChange={onToggle} aria-label={`#${pr.number} ${pr.title}`} />
          <span className="box" aria-hidden />
        </span>
        <span className="mono pr-n">#{pr.number}</span>
        <span className="pick-text">
          <span className="t">{pr.title}</span>
          <span className="sub mono">
            {pr.headRefName} → {pr.baseRefName}
          </span>
        </span>
        <span className="pick-meta">
          {pr.draft && <span className="hint">draft</span>}
          {pr.additions + pr.deletions > 0 && (
            <span className="mono">
              <span className="add-n">+{pr.additions}</span> <span className="del-n">−{pr.deletions}</span>
            </span>
          )}
        </span>
        <span className="pos" aria-hidden>
          {pos > 0 ? pos : ''}
        </span>
      </label>
    </li>
  );
}

function Order({ order, all, trunk, title, setTitle, move, drop, autoOrder, adding }: { order: number[]; all: Map<number, Candidate>; trunk: string; title: string; setTitle: (t: string) => void; move: (i: number, by: -1 | 1) => void; drop: (n: number) => void; autoOrder: () => void; adding: boolean }) {
  const heads = new Map(order.map((n, i) => [all.get(n)!.headRefName, i]));
  const open = new Map([...all.values()].map((p) => [p.headRefName, p.number]));
  return (
    <div className="pick-order">
      {!adding && (
        <label className="field">
          <span className="section-label">Stack name</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Named after the first PR" maxLength={120} />
        </label>
      )}
      <div className="order-head">
        <span className="section-label">{adding ? 'Added at the end, in this order' : 'Review and merge order'}</span>
        {order.length > 1 && (
          <button className="btn ghost small" onClick={autoOrder} title="Each PR after the one its branch is built on">
            Order by bases
          </button>
        )}
      </div>
      <ol className="order-list">
        {!adding && (
          <li className="order-trunk mono">
            <span className="spine-rail">
              <span className="sdot trunk sm" aria-hidden />
            </span>
            {trunk}
          </li>
        )}
        {order.length === 0 && <li className="hint order-empty">Tick pull requests. They're reviewed and merged in this order, top first.</li>}
        {order.map((n, i) => {
          const p = all.get(n)!;
          const baseAt = heads.get(p.baseRefName);
          const baseOpen = open.get(p.baseRefName);
          const warn = baseAt !== undefined && baseAt > i ? `Built on #${order[baseAt]}: it has to come after it` : baseAt === undefined && baseOpen !== undefined ? `Built on #${baseOpen}, which isn't in this stack` : null;
          return (
            <li key={n} className={`order-item ${warn ? 'misplaced' : ''}`}>
              <span className="spine-rail">
                <span className="order-n">{i + 1}</span>
              </span>
              <span className="order-card">
                <span className="pick-text">
                  <span className="t">{p.title}</span>
                  <span className="sub">
                    <span className="mono">#{n}</span> · on {baseAt !== undefined ? `#${order[baseAt]}` : p.baseRefName}
                  </span>
                  {warn && <span className="order-warn">{warn}</span>}
                </span>
                <span className="order-moves">
                  <button className="icon-btn" aria-label={`Move #${n} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon name="chevron-up" size={16} />
                  </button>
                  <button className="icon-btn" aria-label={`Move #${n} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                    <Icon name="chevron-down" size={16} />
                  </button>
                  <button className="icon-btn" aria-label={`Take #${n} out`} onClick={() => drop(n)}>
                    <Icon name="close" size={15} />
                  </button>
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * New stack (or more PRs for one): a project's open PRs with checkboxes on one
 * side, the order they'll be reviewed and merged in on the other.
 */
export function Compose({ stack, narrow, onBack, onDone }: { stack: Stack | null; narrow: boolean; onBack: () => void; onDone: (s: Stack) => void }) {
  const [repos, setRepos] = useState<{ root: string; repo: string; trunk: string }[] | null>(null);
  const [root, setRoot] = useState(stack?.repoRoot ?? '');
  const [cands, setCands] = useState<Candidates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [title, setTitle] = useState('');
  const [titled, setTitled] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stack) return;
    api.repos().then((r) => {
      setRepos(r);
      setRoot((cur) => cur || (r.some((x) => x.root === lastRoot()) ? lastRoot() : (r[0]?.root ?? '')));
    }, (e) => setError(e.message));
  }, [stack?.id]);
  useEffect(() => {
    if (!root) return;
    setCands(null);
    setError(null);
    setOrder([]);
    if (!stack) rememberRoot(root);
    api.candidates(root).then(setCands, (e) => setError(e.message));
  }, [root]);

  const all = useMemo(() => {
    const m = new Map<number, Candidate>();
    const walk = (t: CandidateTree) => (m.set(t.pr.number, t.pr), t.children.forEach(walk));
    cands?.trees.forEach(walk);
    return m;
  }, [cands]);
  const mine = new Set(stack?.layers.map((l) => l.pr) ?? []);
  const taken = (p: Candidate) => p.inStack !== null || mine.has(p.number);
  const q = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      cands
        ? groups(cands, all)
            .map((g) => ({ ...g, rows: g.rows.filter((r) => !taken(r.pr) && (!q || `#${r.pr.number} ${r.pr.title} ${r.pr.headRefName}`.toLowerCase().includes(q))) }))
            .filter((g) => g.rows.length)
        : [],
    [cands, all, q, stack?.id],
  );
  const elsewhere = useMemo(() => {
    const out = new Map<string, number>();
    for (const p of all.values()) if (p.inStack && p.inStack !== stack?.id) out.set(p.inStack, (out.get(p.inStack) ?? 0) + 1);
    return [...out].map(([id, n]) => ({ id, n, title: cands?.stacks.find((s) => s.id === id)?.title ?? 'another stack' }));
  }, [all, cands, stack?.id]);

  useEffect(() => {
    if (!titled) setTitle(order.length ? all.get(order[0])!.title : '');
  }, [order[0], titled]);

  const toggle = (n: number) =>
    setOrder((cur) => {
      if (cur.includes(n)) return cur.filter((x) => x !== n);
      // Right after what it's built on (and that one's own followers), else at the end.
      const heads = new Map(cur.map((x) => [all.get(x)!.headRefName, x]));
      const chainOf = (x: number): number[] => {
        const base = heads.get(all.get(x)!.baseRefName);
        return base === undefined ? [x] : [x, ...chainOf(base)];
      };
      const base = heads.get(all.get(n)!.baseRefName);
      if (base === undefined) return [...cur, n];
      const at = Math.max(...cur.map((x, i) => (chainOf(x).includes(base) ? i : -1)));
      return [...cur.slice(0, at + 1), n, ...cur.slice(at + 1)];
    });
  const pickAll = (g: Group) =>
    setOrder((cur) => {
      const add = g.rows.map((r) => r.pr.number).filter((n) => !cur.includes(n));
      return byBases([...cur, ...add], all);
    });
  const move = (i: number, by: -1 | 1) =>
    setOrder((cur) => {
      const next = [...cur];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });
  const heads = new Map(order.map((n, i) => [all.get(n)!.headRefName, i]));
  const blocked = order.some((n, i) => (heads.get(all.get(n)!.baseRefName) ?? -1) > i);

  const startNative = async (n: number) => {
    setBusy(true);
    try {
      onDone(await api.create(root, { native: n }, titled ? title.trim() : undefined));
    } catch (e) {
      showError(e, "Couldn't start the review");
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!order.length || blocked) return;
    setBusy(true);
    try {
      const s = stack ? await api.addLayers(stack.id, order) : await api.create(root, { prs: order }, titled ? title.trim() : undefined);
      onDone(s);
    } catch (e) {
      showError(e, stack ? "Couldn't add them" : "Couldn't start the review");
    } finally {
      setBusy(false);
    }
  };

  const repo = stack ? stack.repo : (repos?.find((r) => r.root === root)?.repo ?? cands?.repo ?? '');
  const startText = busy ? (stack ? 'Adding…' : 'Starting…') : order.length ? `${stack ? 'Add' : 'Start review'} · ${order.length} PR${order.length === 1 ? '' : 's'}` : 'Pick pull requests';
  const orderPane = (
    <Order
      order={order}
      all={all}
      trunk={cands?.trunk ?? ''}
      title={title}
      setTitle={(t) => (setTitle(t), setTitled(true))}
      move={move}
      drop={(n) => setOrder((cur) => cur.filter((x) => x !== n))}
      autoOrder={() => setOrder((cur) => byBases(cur, all))}
      adding={!!stack}
    />
  );
  const foot = (
    <p className="hint pick-foot">
      {blocked
        ? 'A PR sits above the PR its branch is built on. Move it down, or Order by bases.'
        : order.some((n) => heads.has(all.get(n)!.baseRefName))
          ? `PRs built on another's branch target ${cands?.trunk ?? 'the trunk'} once that one merges; their agent restacks them.`
          : order.length > 1
            ? 'These merge one at a time, in this order. None is built on another.'
            : ''}
    </p>
  );

  return (
    <div className={`page review-pick ${narrow ? 'phone' : ''}`} data-title={stack ? `Add to ${stack.title}` : 'New stack'}>
      <header className="review-head">
        <button className="icon-btn round" onClick={onBack} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
        <div className="grow">
          <h1 className="review-title">{stack ? `Add to ${stack.title}` : 'New stack'}</h1>
          <p className="tagline">
            {repo}
            {cands ? ` · ${all.size} open pull request${all.size === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        {!stack && repos && repos.length > 1 && (
          <select className="review-select" aria-label="Project" value={root} onChange={(e) => setRoot(e.target.value)}>
            {repos.map((r) => (
              <option key={r.root} value={r.root}>
                {repos.filter((x) => x.repo === r.repo).length > 1 ? `${r.repo} · ${r.root.replace(/^\/home\/[^/]+/, '~')}` : r.repo}
              </option>
            ))}
          </select>
        )}
        {!narrow && (
          <label className="pick-filter">
            <Icon name="search" size={15} />
            <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by title, branch or #" aria-label="Filter pull requests" />
          </label>
        )}
      </header>
      <div className="pick-body">
        <section className="pick-list" aria-label="Open pull requests">
          {repos?.length === 0 && <p className="panel-msg">No GitHub repository among your sessions' projects. Start a session in one, with gh signed in.</p>}
          {error && <p className="panel-msg">{error}</p>}
          {!cands && !error && root && <p className="panel-msg">Asking GitHub…</p>}
          {cands && all.size === 0 && <p className="panel-msg">No open pull requests in {cands.repo}.</p>}
          {cands && all.size > 0 && shown.length === 0 && <p className="panel-msg">{q ? 'Nothing matches.' : 'Every open pull request is already in review.'}</p>}
          {shown.map((g) => (
            <div key={g.key} className="pick-group">
              <div className="pick-group-head">
                <h2 className="section-label">{g.label}</h2>
                {g.native !== undefined && !stack ? (
                  <button className="btn small" disabled={busy} onClick={() => startNative(g.native!)} title="Its PRs in GitHub's order. PRs added to it on GitHub join the review.">
                    Review this stack
                  </button>
                ) : (
                  g.chain && (
                    <button className="btn ghost small" onClick={() => pickAll(g)}>
                      {g.native !== undefined ? 'Select the stack' : 'Select the chain'}
                    </button>
                  )
                )}
              </div>
              <ul className="pick-rows">
                {g.rows.map((r) => (
                  <Row key={r.pr.number} pr={r.pr} depth={g.chain ? r.depth : 0} on={order.includes(r.pr.number)} pos={order.indexOf(r.pr.number) + 1} onToggle={() => toggle(r.pr.number)} />
                ))}
              </ul>
            </div>
          ))}
          {elsewhere.length > 0 && (
            <div className="pick-group-head">
              <h2 className="section-label">Already in review</h2>
            </div>
          )}
          {elsewhere.map((e) => (
            <a key={e.id} className="pick-elsewhere" href={`#${reviewHash(e.id)}`}>
              <span className="grow">
                {e.n} pull request{e.n === 1 ? '' : 's'} in <b>{e.title}</b>
              </span>
              <span className="hint">Open</span>
            </a>
          ))}
        </section>
        {!narrow && (
          <aside className="pick-side">
            {orderPane}
            <footer className="pick-go">
              {foot}
              <ConfirmButton className="btn primary" disabled={!order.length || blocked || busy} onClick={start}>
                {startText}
              </ConfirmButton>
            </footer>
          </aside>
        )}
      </div>
      {narrow && (
        <footer className="merge-bar pick-bar">
          <button className="pick-count" disabled={!order.length} onClick={() => setSheet(true)}>
            <span className="n">{order.length ? `${order.length} picked` : 'None picked'}</span>
            {order.length > 0 && <span className="hint">{blocked ? 'Fix the order ›' : 'Review order ›'}</span>}
          </button>
          <button className="btn primary" disabled={!order.length || blocked || busy} onClick={start}>
            {stack ? 'Add' : 'Start review'}
          </button>
        </footer>
      )}
      {narrow && sheet && (
        <Sheet label="Review order" className="pick-sheet" onClose={() => setSheet(false)}>
          <div className="pick-sheet-body">
            {orderPane}
            {foot}
          </div>
        </Sheet>
      )}
    </div>
  );
}
