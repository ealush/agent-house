// Rejecting a layer says what you want for it: changed (it stays, and the agent gets your
// note), out of the stack (its PR stays open on GitHub), or closed on GitHub.
import { useEffect, useRef, useState } from 'react';
import type { Layer, Stack } from '../reviewApi.ts';
import { ConfirmButton } from '../ConfirmButton.tsx';
import { SheetBar, useSheet } from '../sheet.tsx';

export type Rejection = { kind: 'changes' | 'out' | 'close'; note: string };

export function RejectDialog({ stack, layer, agent, onClose, onChoose }: { stack: Stack; layer: Layer; agent: string; onClose: () => void; onChoose: (r: Rejection) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [kind, setKind] = useState<Rejection['kind']>('changes');
  const [note, setNote] = useState('');
  useEffect(() => dialog.current?.showModal(), []);
  const name = layer.role || `#${layer.pr}`;
  const canOut = stack.layers.length > 1;
  const last = stack.layers.filter((l) => l.state === 'open').length <= 1;
  const choices: { kind: Rejection['kind']; title: string; hint: string; off?: boolean }[] = [
    { kind: 'changes', title: 'Request changes', hint: `It stays in the stack. You say what should change next, and ${agent === 'session' ? 'the agent' : agent} gets it with the layer and commit it's about.` },
    { kind: 'out', title: 'Take it out of the stack', hint: `Its PR stays open on GitHub; it leaves this review with its findings.`, off: !canOut },
    { kind: 'close', title: `Close #${layer.pr} on GitHub`, hint: `Out completely: the PR is closed, its branch stays.${last ? ' It is the last open layer, so the review goes too.' : ''}` },
  ];
  const confirm = kind === 'changes' ? 'Write the request…' : kind === 'out' ? 'Take it out' : `Close #${layer.pr}`;

  return (
    <dialog ref={dialog} className="dialog review-reject" aria-labelledby="reject-title" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onChoose({ kind, note: note.trim() });
          onClose();
        }}
      >
        <header className="ns-head">
          <h2 id="reject-title">Reject {name}</h2>
        </header>
        <p className="hint">{layer.title}</p>
        <div className="reject-choices" role="radiogroup" aria-label="What happens to it">
          {choices.map((c) => (
            <label key={c.kind} className={`reject-choice ${kind === c.kind ? 'on' : ''} ${c.off ? 'off' : ''}`}>
              <input type="radio" name="reject" value={c.kind} checked={kind === c.kind} disabled={c.off} onChange={() => setKind(c.kind)} />
              <span className="reject-text">
                <span className="reject-title">{c.title}</span>
                <span className="hint">{c.off ? 'It is the only layer in the stack.' : c.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {kind === 'close' && (
          <label className="field">
            <span>A comment on the PR (optional)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Why is this being closed?" />
          </label>
        )}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={dismiss}>
            Cancel
          </button>
          <span className="spacer" />
          <ConfirmButton type="submit" className={`btn ${kind === 'changes' ? 'primary' : kind === 'close' ? 'danger-solid' : 'danger'}`}>
            {confirm}
          </ConfirmButton>
        </div>
      </form>
    </dialog>
  );
}
