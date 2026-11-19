// The agents a session's agent spawned (server/subagents, docs/spec/16-subagents.md): a pill
// in the session's header while it has any, and a dialog with their tree beside the chosen
// one's conversation, read through the same GUI surface an ended session's is. Read-only:
// no harness lets a message or a stop reach one child of a running agent.
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { HostApi, Win } from './api.ts';
import type { SubagentSummary, SubagentTree, SubagentView } from '../server/subagents/model.ts';
import { surfaceFor } from './surface.ts';
import { SheetBar, useSheet } from './sheet.tsx';
import { age } from './agents.ts';

type Tree = SubagentTree & { self: string | null };

/** What the pill says: what's working, else what's done. Counts cover every level below. */
export function subagentsLabel(s: SubagentSummary): string {
  if (s.active > 0) return `${s.active} active`;
  const stopped = s.total - s.completed - s.failed;
  const parts = [s.completed ? `${s.completed} done` : '', s.failed ? `${s.failed} failed` : '', stopped && (s.completed || s.failed) ? `${stopped} stopped` : ''].filter(Boolean);
  return parts.join(' · ') || String(s.total);
}

export function SubagentsPill({ w, onOpen }: { w: Win; onOpen: () => void }) {
  const s = w.subagents;
  if (!s?.total) return null;
  return (
    <button className={`pill subagents-pill${s.active ? ' busy' : ''}`} onClick={onOpen} title="Show the agents it spawned" aria-label={`Subagents, ${subagentsLabel(s)}`}>
      <span aria-hidden>⑃</span> Subagents · {subagentsLabel(s)}
    </button>
  );
}

const WORD: Record<SubagentView['state'], string> = {
  running: 'Running',
  waiting: 'Waiting on its subagents',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
  unknown: 'Stopped',
};

/** A child's conversation as the GUI surface reads one: a stand-in window under its ref. */
function childWin(w: Win, node: SubagentView): Win {
  return {
    ...w,
    id: '',
    key: '',
    uid: node.ref,
    name: node.name,
    title: node.name,
    harnessId: node.agentId,
    status: node.state === 'running' ? 'busy' : 'idle',
    detail: node.activity,
    ask: null,
    answerable: false,
    queued: 0,
    feed: node.harness,
    fork: null,
    continued: null,
    subagents: null,
  } as Win;
}

/**
 * The tree, parents first, and the chosen child's conversation beside it (under it on a
 * phone). `open`: a child's ref, or the call that spawned it, to start on. The tree is asked
 * for again whenever the row's `rev` says it changed.
 */
export function SubagentsDialog({ w, client, open, onClose }: { w: Win; client: HostApi; open?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [tree, setTree] = useState<Tree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const rev = w.subagents?.rev;

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    let live = true;
    client
      .subagents(w.uid)
      .then((t) => {
        if (!live) return;
        setTree(t);
        setError(null);
        setChosen((c) => c ?? t.nodes.find((n) => n.ref === open || (open && n.toolCallId === open))?.ref ?? t.nodes[0]?.ref ?? null);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [client, w.uid, rev, open]);

  const node = useMemo(() => tree?.nodes.find((n) => n.ref === chosen) ?? null, [tree, chosen]);
  const parentName = node && tree ? (node.parentRef === tree.root.ref ? tree.root.title : tree.nodes.find((n) => n.ref === node.parentRef)?.name ?? tree.root.title) : '';
  const Surface = surfaceFor('gui');

  return (
    <dialog ref={dialog} className="dialog wide subagents" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()} aria-label="Subagents">
      <SheetBar onClose={dismiss} title="Subagents" />
      <div className="subagents-body">
        <ul className="subagents-tree" role="tree" aria-label={`Subagents of ${w.title}`}>
          {error && !tree && <li className="form-error">{error}</li>}
          {!tree && !error && <li className="hint">Reading the tree…</li>}
          {tree && !tree.nodes.length && <li className="hint">None yet. When the agent hands work to subagents, they show here, and stay once they’re done.</li>}
          {tree?.nodes.map((n) => (
            <li key={n.ref} role="treeitem" aria-level={n.depth} aria-selected={n.ref === chosen}>
              <button className={`subagent-row ${n.ref === chosen ? 'on' : ''}`} style={{ paddingInlineStart: `${10 + (n.depth - 1) * 16}px` }} onClick={() => setChosen(n.ref)}>
                <span className={`subagent-dot ${n.state}`} aria-hidden />
                <span className="subagent-text">
                  <span className="subagent-name">{n.name}</span>
                  <span className="subagent-meta">
                    {WORD[n.state]}
                    {n.role ? ` · ${n.role}` : ''}
                    {n.background ? ' · background' : ''}
                    {n.startedAt ? ` · ${age(n.startedAt)}` : ''}
                  </span>
                  {n.activity && <span className="subagent-activity">{n.activity}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <section className="subagents-child">
          {node ? (
            <>
              <header className="subagent-head">
                <span className={`subagent-dot ${node.state}`} aria-hidden />
                <span className="subagent-name">{node.name}</span>
                <span className="hint">
                  {WORD[node.state]} · subagent of {parentName}
                </span>
              </header>
              <div className="subagent-feed">
                <Suspense fallback={<div className="surface" />}>
                  <Surface key={node.ref} w={childWin(w, node)} client={client} hidden={false} showKeys={false} onAnswer={() => {}} onReply={() => {}} onUseTerminal={() => {}} refresh={() => {}} />
                </Suspense>
              </div>
              <p className="subagent-readonly hint">Read only: its parent agent runs it. To steer it, message the parent.</p>
            </>
          ) : (
            tree?.nodes.length ? <p className="hint">Pick a subagent to read its conversation.</p> : null
          )}
        </section>
      </div>
    </dialog>
  );
}
