import { Suspense, useEffect, useRef, useState } from 'react';
import type { HistoryItem, HostApi, Win } from './api.ts';
import { age, look, shortModel } from './agents.ts';
import { AgentLogo } from './logos.tsx';
import { Icon } from './icons.tsx';
import { ConfirmButton } from './ConfirmButton.tsx';
import { showError } from './ask.tsx';
import { surfaceFor } from './surface.ts';
import { useDraftSync } from './useDraftSync.ts';
import { interruptedLine, wasWord } from './InterruptedCard.tsx';
import { useReviewFor } from './reviewContext.ts';

type Props = {
  item: HistoryItem;
  client: HostApi;
  /** The harness's transcript adapter: the conversation stays readable in the GUI. */
  feed: string | null;
  narrow: boolean;
  /** Resume the session; it comes back under the same key, so the view turns live in place. */
  onResume: () => Promise<void>;
  /** Back on a phone, Close in a pane. */
  onClose: () => void;
  closeLabel?: string;
};

/** A stand-in window for reading an ended conversation in the GUI surface. */
function readOnlyWin(item: HistoryItem, feed: string): Win {
  return {
    id: '', host: item.host, key: '', session: '', index: 0, name: item.title, title: item.title, uid: item.ref,
    agent: item.harness, harnessId: item.harnessId, model: item.model, statusSource: 'activity', command: item.harness,
    cwd: item.cwd, project: item.project, projectPath: item.cwd, branch: null, worktree: !!item.worktree,
    status: 'idle', detail: null, ask: null, answerable: false, viewers: 0, devices: [], activity: item.at, createdAt: item.at,
    panes: 1, pinned: item.pinned, queued: 0, unsent: 0, order: null, launch: null, launchModel: null, launchEffort: null, launchMode: null,
    feed, fork: null,
  };
}

/**
 * A session that ended, shown where it was: the same header, the conversation
 * (when the agent has a transcript adapter), and one bar to pick it back up.
 * Typing a message resumes the session and delivers it.
 */
export function EndedSession({ item, client, feed, narrow, onResume, onClose, closeLabel = 'Close' }: Props) {
  const [text, setText] = useState('');
  const draftSync = useDraftSync(client, item.ref, text, setText);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const agent = item.harness === 'shell' ? null : item.harness;
  const name = look(agent).name;
  const Surface = feed ? surfaceFor('gui') : null;
  const win = feed ? readOnlyWin(item, feed) : null;
  const review = useReviewFor(item.host, item.ref, null, item.project);

  useEffect(() => {
    if (!narrow) box.current?.focus({ preventScroll: true });
  }, [item.ref]);

  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      const msg = text.trim();
      if (item.interrupted) {
        // Restored first (server/interruptions): told where it stopped, then your message after.
        await onResume();
        if (msg) {
          await client.send(item.ref, msg, true);
          setText('');
          draftSync.saveNow('');
        }
        return;
      }
      if (msg) {
        // The send path resumes a dead session first, then delivers.
        await client.send(item.ref, msg, true);
        setText('');
        draftSync.saveNow('');
      }
      await onResume();
    } catch (e) {
      showError(e, cut ? "Couldn't restore" : "Couldn't resume");
    } finally {
      setBusy(false);
    }
  }

  const cut = item.interrupted ?? null;
  const endedWord = `${cut ? 'Interrupted' : 'Ended'} ${age(item.at) === 'now' ? 'just now' : `· ${age(item.at)}`}`;
  const pill = cut ? 'pill ended interrupted' : 'pill ended';
  const verb = cut ? 'Restore' : 'Resume';
  const reviewPill = review?.link ? (
    <button
      type="button"
      className={`pill review-pill ${review.link.readyToMerge ? 'attention' : review.link.needsYou > 0 ? 'waiting' : ''}`}
      onClick={() => review.open(review.link!.stackId, review.link!.pr)}
      title={`Open "${review.link.stackTitle}" in Review`}
    >
      <Icon name="stack" size={13} />
      {review.link.role || (review.link.pr ? `#${review.link.pr}` : 'Review')}
    </button>
  ) : null;

  return (
    // A screen for ⌘↵ (confirm.ts): Resume answers it from anywhere in the view.
    <div className="ended-session" data-confirm>
      <header className="session-head">
        {narrow ? (
          <button className="icon-btn" onClick={onClose} aria-label="Back">
            <Icon name="back" size={24} />
          </button>
        ) : (
          <span className="chip lg" style={{ '--agent': look(agent).color } as React.CSSProperties}>
            <AgentLogo id={agent} size={17} />
          </span>
        )}
        {narrow ? (
          // As a live session's phone header: the title first, the status leading the line under it.
          <>
            <div className="session-title">
              <span className="name static">{item.title}</span>
              <span className="eyebrow">
                <span className={pill}>{endedWord}</span>
                {[agent ? name : 'Shell', item.project].filter(Boolean).join(' · ')}
              </span>
            </div>
            {reviewPill}
          </>
        ) : (
          <>
            <div className="session-title">
              <span className="eyebrow">{[item.project, agent ? name : item.cwd, shortModel(item.model)].filter(Boolean).join(' · ')}</span>
              <span className="name static">{item.title}</span>
            </div>
            <div className="session-pills">
              <span className={pill} title={cut ? `${interruptedLine(cut)}; it ${wasWord(cut)}` : undefined}>
                {endedWord}
              </span>
              {reviewPill}
            </div>
          </>
        )}
        {!narrow && (
          <button className="btn ghost small" onClick={onClose}>
            {closeLabel}
          </button>
        )}
      </header>
      <div className="session-body">
        <div className="session-main">
          {Surface && win ? (
            <Suspense fallback={<div className="surface" />}>
              <Surface w={win} client={client} hidden={false} showKeys={false} onAnswer={() => {}} onReply={() => box.current?.focus()} onUseTerminal={() => void go()} refresh={() => {}} />
            </Suspense>
          ) : (
            <div className="ended-empty">
              <span className="chip xl" style={{ '--agent': look(agent).color } as React.CSSProperties}>
                <AgentLogo id={agent} size={28} />
              </span>
              <p>
                <strong>{item.title}</strong> {cut ? 'was interrupted' : 'ended'} {age(item.at) === 'now' ? 'just now' : `${age(item.at)} ago`}.
              </p>
              <p className="hint">{verb} starts {agent ? `${name} on the same conversation` : 'a shell'} in {item.cwd}.</p>
            </div>
          )}
          {cut && (
            <p className="interrupted-note" role="status">
              {interruptedLine(cut)}, and it {wasWord(cut)}. {cut.midTurn ? `${verb} brings it back in the same conversation and tells it where it stopped, before your message.` : `${verb} brings it back in the same conversation.`}
            </p>
          )}
          <form
            className="composer ended-bar"
            onSubmit={(e) => {
              e.preventDefault();
              void go();
            }}
          >
            <textarea
              ref={box}
              rows={1}
              value={text}
              disabled={busy}
              placeholder={agent ? 'Continue the conversation…' : 'Resume the shell'}
              aria-label="Message to send when the session resumes"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void go();
                }
              }}
            />
            <ConfirmButton type="submit" className="btn primary" disabled={busy}>
              {busy ? (cut ? 'Restoring…' : 'Resuming…') : text.trim() ? `${verb} and send` : verb}
            </ConfirmButton>
          </form>
        </div>
      </div>
    </div>
  );
}
