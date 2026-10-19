// Merging the whole stack: what lands, in how many steps, what it marks
// reviewed on the way, and where it stops. The host checks every gate again.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewApi, Stack } from '../reviewApi.ts';
import { ConfirmButton } from '../ConfirmButton.tsx';
import { Glide } from '../Glide.tsx';
import { Icon } from '../icons.tsx';
import { SheetBar, useSheet } from '../sheet.tsx';
import { errorText } from '../errors.ts';
import { planStackMerge, type Method, type MergeRow } from './stackMerge.ts';

const METHOD: Record<Method, string> = { merge: 'Merge commits', squash: 'Squash', rebase: 'Rebase' };
const toast = (text: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: text }));

export type StackMergeOut = Awaited<ReturnType<ReviewApi['mergeStack']>>;

export function StackMergeDialog({
  api,
  stack,
  onClose,
  onMerged,
  onAskAgent,
}: {
  api: ReviewApi;
  stack: Stack;
  onClose: () => void;
  onMerged: (out: StackMergeOut) => void;
  /** Hand the merge to the agent instead: up to this layer, with this method. */
  onAskAgent: (method: Method, upTo: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [method, setMethod] = useState<Method>(stack.mergeMethod);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => dialog.current?.showModal(), []);
  const plan = useMemo(() => planStackMerge(stack, method), [stack, method]);
  const name = (pr: number) => {
    const l = stack.layers.find((x) => x.pr === pr);
    return l ? l.role || `#${l.pr}` : `#${pr}`;
  };
  const all = plan.lands.length === plan.rows.length;
  const steps = new Set(plan.rows.filter((r) => r.state === 'ready' || r.state === 'review').map((r) => r.step)).size;
  const range = plan.lands.length > 1 ? `${name(plan.lands[0].pr)}–${name(plan.upTo!.pr)}` : plan.upTo ? name(plan.upTo.pr) : '';
  const verb = plan.review.length ? 'Mark reviewed & merge' : 'Merge';
  const button = all ? `${verb} ${plan.lands.length === 1 ? 'it' : `all ${plan.lands.length}`}` : `${verb} ${range}`;
  // The agent can do the restacks ah won't; it stops only where a gate holds a layer (whatever the method).
  const gated = useMemo(() => planStackMerge(stack, 'merge'), [stack]);
  const held = gated.rows.findIndex((r) => r.state === 'held');
  const agentUpTo = (held < 0 ? gated.rows.at(-1) : gated.rows[held - 1])?.layer ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!plan.upTo) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.mergeStack(stack.id, { method, markReviewed: plan.review.length > 0, upTo: plan.upTo.pr });
      const landed = out.merged.length === 1 ? name(out.merged[0]) : `${out.merged.length} layers`;
      toast(
        out.waiting
          ? `${out.merged.length ? `Merged ${landed} · ` : ''}${out.waiting === 'queue' ? 'the rest is in the merge queue' : 'GitHub is still merging'}`
          : out.stopped
            ? `${out.merged.length ? `Merged ${landed} · ` : ''}stopped at ${name(out.stopped.pr)}: ${out.stopped.why}`
            : `Merged ${landed} into ${stack.trunk}`,
      );
      onMerged(out);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const note = (r: MergeRow) => {
    if (r.state === 'review') return `Marked reviewed at ${r.layer.current?.headSha.slice(0, 7) ?? 'its head'}`;
    if (r.state !== 'ready') return r.why;
    const with_ = plan.rows.filter((x) => x.step === r.step && x.layer !== r.layer && (x.state === 'ready' || x.state === 'review'));
    return with_.length && r.layer.ghStack !== null ? `One GitHub stack merge with ${with_.map((x) => name(x.layer.pr)).join(', ')}` : 'Ready';
  };

  return (
    <dialog ref={dialog} className="dialog wide review-merge-stack" aria-labelledby="merge-stack-title" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form onSubmit={submit}>
        <header className="ns-head">
          <h2 id="merge-stack-title">
            Merge {stack.title} into {stack.trunk}
          </h2>
        </header>
        <p className="hint">
          Bottom up, {steps === 1 ? 'in one step' : `in ${steps} steps`}, each at the head you reviewed{plan.lands.some((l) => l.ghStack !== null) ? "; a run of layers in one GitHub stack lands through GitHub's stack merge, all or none" : ''}. It stops at the first step GitHub refuses.
        </p>
        {stack.methods.length > 1 && (
          <div className="merge-how">
            <span className="hint">Each layer lands as</span>
            <div className="seg" role="radiogroup" aria-label="Merge method">
              <Glide match=".on" className="thumb" />
              {stack.methods.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>
                  {METHOD[m]}
                </button>
              ))}
            </div>
          </div>
        )}
        <ol className="stack-land">
          <li className="land-trunk mono">
            <Icon name="branch" size={14} /> {stack.trunk}
          </li>
          {plan.rows.map((r) => (
            <li key={r.layer.pr} className={`land-row ${r.state}`}>
              <span className="land-mark" aria-hidden>
                {(r.state === 'ready' || r.state === 'review') && <Icon name="check" size={13} />}
              </span>
              <span className="role-chip">{r.layer.role || `#${r.layer.pr}`}</span>
              <span className="land-title">{r.layer.title}</span>
              <span className="land-note">{note(r)}</span>
            </li>
          ))}
        </ol>
        {plan.review.length > 0 && (
          <p className="merge-note">
            <Icon name="check" size={16} />
            <span>
              You haven't marked {plan.review.map((l) => name(l.pr)).join(', ')} reviewed at {plan.review.length === 1 ? 'its' : 'their'} current head{plan.review.length === 1 ? '' : 's'}. Merging marks {plan.review.length === 1 ? 'it' : 'them'}.
            </span>
          </p>
        )}
        {plan.stop && (
          <p className="merge-note held">
            <Icon name="ban" size={16} />
            <span>
              {plan.stop.state === 'restack'
                ? `${METHOD[method]} rewrites what ${name(plan.stop.layer.pr)} sits on, so it needs a restack before it can land, and ah doesn't rewrite branches. Ask the agent, which restacks as it goes${stack.link?.ok ? ', make it a stack on GitHub (··· menu) so GitHub restacks it' : ''}, or merge with merge commits.`
                : `${name(plan.stop.layer.pr)} is held: ${plan.stop.why}.${plan.upTo ? ` ${range} can land now; the rest waits.` : ''}`}
            </span>
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={dismiss}>
            Cancel
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn"
            disabled={busy || !agentUpTo}
            title={agentUpTo ? 'Draft a message asking the agent that owns the stack to merge it; you edit it before it goes' : undefined}
            onClick={() => {
              onAskAgent(method, agentUpTo!.pr);
              onClose();
            }}
          >
            Ask the agent…
          </button>
          <ConfirmButton type="submit" className="btn primary" disabled={busy || !plan.upTo}>
            {busy ? 'Merging…' : plan.upTo ? button : 'Nothing can land yet'}
          </ConfirmButton>
        </div>
      </form>
    </dialog>
  );
}
