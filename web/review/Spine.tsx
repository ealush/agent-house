// The stack drawn as a spine: trunk at the top, the layers under it in merge
// order, each with one dot in the shared status vocabulary. Wide beside the
// overview, a column of labels beside a layer, a bar on the list.
import { useEffect, useRef } from 'react';
import { toneOf, type Layer, type LayerStatus, type Stack, type Tone } from '../reviewApi.ts';
import { Icon } from '../icons.tsx';
import { look } from '../agents.ts';

/** What a layer is waiting on, in a few words. */
export function layerLine(l: Layer): string {
  const d = l.dispatch;
  if (l.status === 'merged') return 'Merged';
  if (l.status === 'closed') return 'Closed on GitHub';
  if (l.status === 'skipped') return "Skipped · won't merge";
  if (l.status === 'fixing') return `${d?.targetAgent ? look(d.targetAgent).name : 'The agent'} is fixing${d?.findings.length ? ` ${d.findings.length}` : ''}`;
  if (l.status === 'rereview') return l.open ? `Came back · ${l.open} open` : 'Came back';
  if (d?.state === 'no-push') return 'Finished without a push';
  if (l.needs === 'retarget') return 'Needs retargeting';
  if (l.needs === 'restack') return 'Needs a restack';
  if (l.needs === 'conflict') return 'Conflicts';
  if (l.status === 'changes') return `${l.open} finding${l.open === 1 ? '' : 's'} to send`;
  if (l.status === 'approved') return l.gates.every((g) => g.ok) ? 'Reviewed · ready to merge' : 'Reviewed';
  return l.draft ? 'To review · draft' : 'To review';
}

export function Dot({ tone, size = 'md' }: { tone: Tone; size?: 'sm' | 'md' }) {
  return (
    <span className={`sdot ${tone} ${size}`} aria-hidden>
      {(tone === 'ready' || tone === 'merged') && <Icon name="check" size={size === 'sm' ? 9 : 11} />}
    </span>
  );
}

function useIntoView<T extends HTMLElement>(on: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [on]);
  return ref;
}

function Row({ l, on, onPick }: { l: Layer; on: boolean; onPick: () => void }) {
  const ref = useIntoView<HTMLButtonElement>(on);
  const tone = toneOf(l.status);
  return (
    <li>
      <button ref={ref} className={`spine-row ${tone} ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined} onClick={onPick}>
        <span className="spine-rail">
          <Dot tone={tone} />
        </span>
        <span className="spine-text">
          <span className="spine-name">
            <span className="role-chip">{l.role || `#${l.pr}`}</span>
            <span className="t">{l.title}</span>
          </span>
          <span className="spine-sub">{layerLine(l)}</span>
        </span>
      </button>
    </li>
  );
}

/** Beside the overview: every layer with its title and what it waits on. */
export function Spine({ stack, pr, onPick }: { stack: Stack; pr: number | null; onPick: (pr: number | null) => void }) {
  return (
    <nav className="spine" aria-label="Layers" data-rove="button.spine-row, button.spine-top">
      <button className={`spine-top ${pr === null ? 'on' : ''}`} aria-current={pr === null ? 'page' : undefined} onClick={() => onPick(null)}>
        <Icon name="queue" size={15} />
        <span className="grow">Overview</span>
        {stack.decisions.length > 0 && <span className="count" title="Pinned decisions">{stack.decisions.length}</span>}
      </button>
      <div className="spine-trunk mono">
        <span className="spine-rail">
          <span className="sdot trunk sm" aria-hidden />
        </span>
        {stack.trunk}
      </div>
      <ol className="spine-list">
        {stack.layers.map((l) => (
          <Row key={l.pr} l={l} on={l.pr === pr} onPick={() => onPick(l.pr)} />
        ))}
      </ol>
    </nav>
  );
}

function Chip({ l, on, onPick }: { l: Layer; on: boolean; onPick: () => void }) {
  const ref = useIntoView<HTMLButtonElement>(on);
  return (
    <li>
      <button ref={ref} className={`spine-chip ${toneOf(l.status)} ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined} aria-label={`${l.role || `#${l.pr}`}: ${l.title} · ${layerLine(l)}`} title={`${l.title} · ${layerLine(l)}`} onClick={onPick}>
        {l.role || l.pr}
      </button>
    </li>
  );
}

/** Beside a layer: the stack as a column of labels, so the diff gets the room. */
export function SpineColumn({ stack, pr, onPick }: { stack: Stack; pr: number | null; onPick: (pr: number | null) => void }) {
  return (
    <nav className="spine-col" aria-label="Layers" data-rove="button">
      <button className="spine-chip top" aria-label="Stack overview" title="Stack overview" onClick={() => onPick(null)}>
        <Icon name="queue" size={15} />
      </button>
      <ol>
        {stack.layers.map((l) => (
          <Chip key={l.pr} l={l} on={l.pr === pr} onPick={() => onPick(l.pr)} />
        ))}
      </ol>
    </nav>
  );
}

/** On the list: one segment per layer, so a stack's progress reads at a glance. */
export function SpineBar({ spine }: { spine: { pr: number; role: string; status: LayerStatus }[] }) {
  return (
    <span className="spine-bar" style={{ '--n': Math.max(1, spine.length) } as React.CSSProperties} aria-hidden>
      {spine.map((x) => (
        <span key={x.pr} className={`seg-${toneOf(x.status)}`} />
      ))}
    </span>
  );
}
