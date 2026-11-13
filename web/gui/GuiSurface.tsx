// The session as a GUI: a separate component tree that never touches the terminal.
// It renders the agent's typed event stream (server/feed) and talks back through
// the same send/answer API the terminal path uses.
import { forwardRef, memo, startTransition, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FeedPrompt, ToolResult } from '../../server/feed/schema.ts';
import { AskPanel, type AskHandle } from '../AskPanel.tsx';
import type { SurfaceHandle, SurfaceProps } from '../surface.ts';
import type { HistoryItem, SnapshotInfo } from '../api.ts';
import { askConfirm, showError, showNotice } from '../ask.tsx';
import { age, look } from '../agents.ts';
import { AgentLogo } from '../logos.tsx';
import { Icon } from '../icons.tsx';
import { clock } from '../dates.ts';
import { copyText } from '../selection.ts';
import { removeOutgoing, sameText, useOutbox } from '../outbox.ts';
import { blockText } from './reducer.ts';
import { useFeed } from './useFeed.ts';
import { project, type Block } from './reducer.ts';
import { GuiContext, type GuiActions } from './context.ts';
import { ItemView, PartView, UserText } from './router.tsx';
import { AwaitingTool, TurnLive } from './tools.tsx';
import { MessageRail, type RailItem } from './MessageRail.tsx';
import './gui.css';
import { every } from '../poll.ts';

const UNAVAILABLE: Record<string, string> = {
  'no-transcript': 'The conversation will appear here once the agent starts writing it.',
  'no-adapter': 'This agent has no GUI view yet. Use the terminal.',
  'not-found': 'This session is gone.',
};

/**
 * A mount (reload, split, moving a pane) draws the newest blocks first and the
 * older ones in the background, so what is on screen paints without waiting for
 * markdown that is scrolled out of view.
 */
const FIRST_BLOCKS = 16;
const MORE_BLOCKS = 40;

const time = (at: number) => (at ? clock(at) : '');

/** Hover-only copy action below a message. The row is always laid out (see
 *  gui.css: visibility, not display), so appearing never shifts the feed. */
function MsgCopy({ text, bare = false }: { text: string; bare?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  if (!text) return null;
  const button = (
      <button
        className="msg-copy"
        onClick={() => {
          void copyText(text).then((ok) => {
            if (ok) setCopied(true);
            else showNotice('Copy failed', 'Select the text and copy it yourself.');
          });
        }}
        aria-label={copied ? 'Copied' : 'Copy message'}
        title={copied ? 'Copied' : 'Copy message'}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
  );
  return bare ? button : <div className="msg-actions">{button}</div>;
}

type BlockProps = { block: Block; results: Record<string, ToolResult>; agent: string | null; snap?: SnapshotInfo; onRestore?: (snap: SnapshotInfo) => void; freshAfter: number };

/** A block draws again only when it, its results or its snapshot changed: not on every state tick,
 *  which re-rendered every visible message, tool row and copy button each 1.5s. The snapshot list is
 *  polled into new objects, so it compares by value. */
const BlockView = memo(BlockViewImpl, (a: BlockProps, b: BlockProps) =>
  a.block === b.block && a.results === b.results && a.agent === b.agent && a.freshAfter === b.freshAfter && a.onRestore === b.onRestore && JSON.stringify(a.snap ?? null) === JSON.stringify(b.snap ?? null));

function BlockViewImpl({ block, results, agent, snap, onRestore, freshAfter }: BlockProps) {
  // data-seq is the search jump target (issue #9): the block key starts with
  // the seq of its first entry.
  const seq = parseInt(block.key, 10);
  if (block.kind === 'notice')
    return (
      <div data-seq={seq} style={{ display: 'contents' }}>
        <PartView part={block.part} />
      </div>
    );
  if (block.kind === 'user') {
    return (
      <div className="msg user" data-seq={seq} tabIndex={-1}>
        <div className="bubble">
          {block.parts.map((p, i) => (p.type === 'text' ? <UserText key={i} text={p.text} /> : <PartView key={i} part={p} />))}
        </div>
        <div className="msg-meta">
          {snap && (
            <button className="msg-snap" title="Restore the files to how they were before this turn (a safety snapshot is taken first)" onClick={() => onRestore?.(snap)}>
              <Icon name="history" size={12} /> Restore
            </button>
          )}
          <MsgCopy text={blockText(block)} bare />
          <span className="msg-time">{time(block.at)}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="msg agent" data-seq={seq} tabIndex={-1}>
      <span className="chip sm" style={{ '--agent': look(agent).color } as React.CSSProperties}>
        <AgentLogo id={agent} size={13} />
      </span>
      <div className="turn">
        {block.items.map((item) => (
          <div key={item.key} data-seq={parseInt(item.key, 10)} className={parseInt(item.key, 10) > freshAfter ? 'fresh' : undefined}><ItemView item={item} results={results} /></div>
        ))}
        <MsgCopy text={blockText(block)} />
      </div>
    </div>
  );
}

/** "Working · 1:12 · Editing src/x.ts": how long this turn has run, and what it's doing when hooks say. */
function Working({ detail }: { detail: string | null }) {
  const since = useRef(Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((Date.now() - since.current) / 1000);
  const elapsed = s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <div className="working" aria-live="polite">
      <span className="tool-dot running" />
      <span className="working-label">Working · {elapsed}</span>
      {/* A heredoc or a chained script is many lines; its first says what it is. */}
      {detail && <span className="working-detail mono" title={detail}>{detail.split('\n')[0].trim()}</span>}
      <span className="working-hint">Esc stops</span>
    </div>
  );
}

/** A new session: who's listening, and the project's recent sessions to pick back up instead. */
function Blank({ agent, project, recent, onResume }: { agent: string | null; project: string; recent: HistoryItem[]; onResume: (h: HistoryItem) => void }) {
  return (
    <div className="gui-blank">
      <span className="chip xl" style={{ '--agent': look(agent).color } as React.CSSProperties}>
        <AgentLogo id={agent} size={28} />
      </span>
      <p className="gui-blank-title">New conversation{project ? ` in ${project}` : ''}</p>
      <p className="hint">{recent.length ? 'Type below to start, or pick up where you left off.' : 'Type below to start.'}</p>
      {recent.length > 0 && (
        <ul className="empty-recent" data-rove="button.empty-recent-row" aria-label="Pick up where you left off">
          {recent.map((h) => (
            <li key={h.ref}>
              <button className="empty-recent-row" onClick={() => onResume(h)} title={`Resume ${h.title}`}>
                <span className="chip sm" style={{ '--agent': look(h.harness).color } as React.CSSProperties}>
                  <AgentLogo id={h.harness} size={13} />
                </span>
                <span className="grow">{h.title}</span>
                <span className="when">{age(h.at) === 'now' ? 'just now' : age(h.at)}</span>
                <span className="resume-word">Resume</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const GuiSurface = forwardRef<SurfaceHandle, SurfaceProps>(function GuiSurface({ w, client, hidden, onAnswer, onReply, onUseTerminal, refresh, recent, onResume }, ref) {
  const { state, loadOlder, loadingOlder } = useFeed(client, w.uid);
  // What was already there when the conversation opened draws still; what arrives after rises in.
  const freshAfter = useRef<number | null>(null);
  if (freshAfter.current === null && state.entries.length) freshAfter.current = state.entries.reduce((m, e) => Math.max(m, e.seq), 0);
  const [snaps, setSnaps] = useState<SnapshotInfo[]>([]);
  useEffect(() => {
    // A pane out of view (a parked split, another workspace) doesn't poll; it loads when shown.
    if (hidden) return;
    let stopped = false;
    const load = () =>
      client
        .snapshots(w.uid)
        .then((r) => {
          // The same list keeps the old array, so an unchanged poll doesn't re-render the transcript.
          if (!stopped) setSnaps((prev) => (JSON.stringify(prev) === JSON.stringify(r.snapshots) ? prev : r.snapshots));
        })
        .catch(() => {});
    load();
    const stop = every(5000, load);
    return () => {
      stopped = true;
      stop();
    };
  }, [client, w.uid, hidden]);

  const restoreSnapNow = async (snap: SnapshotInfo) => {
    const ok = await askConfirm({
      title: `Restore to before turn ${snap.turn}?`,
      body: 'Files return to how they were before this turn. A safety snapshot of the current state is taken first, so this can itself be undone.',
      confirm: 'Restore',
      danger: true,
    });
    if (!ok) return;
    try {
      try {
        await client.restoreSnapshot(w.uid, snap.turn);
      } catch (e) {
        if (!/agent is working/i.test((e as Error).message)) throw e;
        const stop = await askConfirm({
          title: 'The agent is working',
          body: 'Stop the current turn and restore now?',
          confirm: 'Stop and restore',
          danger: true,
        });
        if (!stop) return;
        await client.restoreSnapshot(w.uid, snap.turn, true);
      }
      refresh();
    } catch (e) {
      showError(e, "Couldn't restore");
    }
  };
  // One function for the feed's life, always running the latest restore: memoized blocks keep it.
  const restoreRef = useRef(restoreSnapNow);
  restoreRef.current = restoreSnapNow;
  const restoreSnap = useCallback((snap: SnapshotInfo) => restoreRef.current(snap), []);
  const blocks = useMemo(() => project(state.entries), [state.entries]);
  // What you sent from here, drawn as your bubble until the transcript has it (or a
  // while passes, for input the agent never records). Queued ones live in the tray.
  const outbox = useOutbox(w.uid);
  const outgoing = useMemo(() => outbox.filter((o) => o.state !== 'queued'), [outbox]);
  useEffect(() => {
    const sent = outgoing.filter((o) => o.state === 'sent');
    if (!sent.length) return;
    // Only user turns from around then on: an older identical message is not this one.
    const users = blocks.filter((b) => b.kind === 'user');
    const done = sent.filter((o) => Date.now() - o.at > 30_000 || users.some((b) => (!b.at || b.at >= o.at - 10_000) && sameText(blockText(b), o.text)));
    removeOutgoing(done.map((o) => o.id));
    const t = setTimeout(() => removeOutgoing(sent.filter((o) => Date.now() - o.at > 30_000).map((o) => o.id)), 30_000);
    return () => clearTimeout(t);
  }, [blocks, outgoing]);
  const [shownCount, setShownCount] = useState(FIRST_BLOCKS);
  const shown = useMemo(() => (shownCount >= blocks.length ? blocks : blocks.slice(-shownCount)), [blocks, shownCount]);
  const allShown = shown.length === blocks.length;
  useEffect(() => {
    if (allShown) return;
    const t = setTimeout(() => startTransition(() => setShownCount((n) => (n + MORE_BLOCKS >= blocks.length ? Infinity : n + MORE_BLOCKS))), 0);
    return () => clearTimeout(t);
  }, [allShown, shownCount, blocks.length]);
  // The rail lists every message you sent: the server's full list (a reload draws
  // only the newest page, which one long turn can fill), plus what arrived since.
  const [prompts, setPrompts] = useState<FeedPrompt[]>([]);
  useEffect(() => {
    let stopped = false;
    client
      .feedPrompts(w.uid)
      .then((r) => {
        if (!stopped) setPrompts(r.prompts);
      })
      .catch(() => {
        if (!stopped) setPrompts([]);
      });
    return () => {
      stopped = true;
    };
  }, [client, w.uid, state.epoch]);
  const railItems = useMemo<RailItem[]>(() => {
    const bySeq = new Map(prompts.map((p) => [p.seq, p.text]));
    for (const b of blocks) if (b.kind === 'user') bySeq.set(parseInt(b.key, 10), blockText(b));
    const sent = [...bySeq].sort((a, b) => a[0] - b[0]).map(([seq, text]) => ({ key: String(seq), seq, text }));
    return [...sent, ...outgoing.map((o) => ({ key: o.id, text: o.text }))];
  }, [prompts, blocks, outgoing]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const prevHeight = useRef(0);
  const prevFirst = useRef<number | undefined>(undefined);
  const prevOut = useRef(0);

  function jumpLatest() {
    stick.current = true;
    const el = scroller.current;
    if (!el) return;
    // Mobile insets can resize as the writing field loses focus. Land at the
    // current end immediately instead of finishing a smooth scroll at a stale end.
    el.scrollTo({ top: el.scrollHeight, behavior: el.closest('.mobile-chat') ? 'instant' : 'smooth' });
  }

  const askRef = useRef<AskHandle>(null);
  // Typing into the agent's input goes through the same path as the terminal.
  useImperativeHandle(ref, () => ({
    insert: (text) => void client.send(w.uid, text, false).catch((e) => showError(e, "Couldn't send")),
    focus: onReply,
    focusAsk: () => askRef.current?.focus() ?? false,
    copyLast: () => {
      const last = [...blocksRef.current].reverse().find((b) => b.kind === 'agent');
      const text = last ? blockText(last) : '';
      if (!text) return showNotice('Nothing to copy', 'The agent has not replied yet.');
      void copyText(text).then((ok) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: ok ? 'Copied the last reply' : "Couldn't copy" })));
    },
    browse: () => {
      const msgs = scroller.current?.querySelectorAll<HTMLElement>('.msg');
      const last = msgs?.[msgs.length - 1];
      if (!last) return false;
      last.focus({ preventScroll: true });
      last.scrollIntoView({ block: 'nearest' });
      return true;
    },
    jumpLatest,
  }));


  const actions = useMemo<GuiActions>(
    () => ({
      reply: (text) => void client.send(w.uid, text, true).catch((e) => showError(e, "Couldn't send")),
      fileUrl: (path) => client.fs.url(path),
      resolvePath: (p) => (p.startsWith('/') || p.startsWith('~') ? p : `${w.cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`),
      displayPath: (p) => {
        const root = w.projectPath.replace(/\/$/, '');
        return root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
      },
    }),
    [client, w.uid, w.cwd, w.projectPath],
  );

  // Search jump (issue #9): a result asked for one entry by seq. Page older
  // entries in until it is loaded, then scroll to it and flash it, once.
  const jumpSeq = useRef<number | null>(null);
  const jumpTries = useRef(0);
  // The rail's jumps put your message at the top, quietly; search results flash in the middle.
  const jumpTop = useRef(false);
  const [jumpVersion, setJumpVersion] = useState(0);
  // A rebuilt projection is a new conversation: start at its end.
  useEffect(() => {
    stick.current = jumpSeq.current === null;
  }, [state.epoch]);

  useEffect(() => {
    const accept = (jump: { host?: string; uid?: string; seq?: number }) => {
      if (jump.host !== w.host || jump.uid !== w.uid || typeof jump.seq !== 'number') return;
      sessionStorage.removeItem('ah.seqJump');
      jumpSeq.current = jump.seq; jumpTries.current = 0; jumpTop.current = false; stick.current = false;
      setJumpVersion((n) => n + 1);
    };
    try {
      const raw = sessionStorage.getItem('ah.seqJump');
      if (raw) accept(JSON.parse(raw));
    } catch {}
    const listener = (event: Event) => accept((event as CustomEvent).detail);
    window.addEventListener('ah:search-jump', listener);
    return () => window.removeEventListener('ah:search-jump', listener);
  }, [w.host, w.uid]);
  useEffect(() => {
    const target = jumpSeq.current;
    if (target == null || state.status === 'unavailable') return;
    // Folded tool results and consecutive tool calls share the preceding rendered group.
    const loaded = state.entries.some((e) => e.seq === target);
    const candidates = Array.from(scroller.current?.querySelectorAll<HTMLElement>('[data-seq]') ?? []);
    // Loaded but still waiting to be drawn: draw everything, then look again.
    if (loaded && !allShown) return setShownCount(Infinity);
    const el = loaded ? candidates.filter((el) => Number(el.dataset.seq) <= target).sort((a, b) => Number(b.dataset.seq) - Number(a.dataset.seq))[0] : undefined;
    if (el) {
      jumpSeq.current = null;
      const box = scroller.current;
      if (jumpTop.current && box) {
        box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 16;
        return;
      }
      el.scrollIntoView({ block: 'center' });
      el.classList.add('jump-flash');
      setTimeout(() => el.classList.remove('jump-flash'), 2400);
      return;
    }
    // Not loaded yet: the snapshot holds only the newest page, so page older.
    if (!loadingOlder && state.hasOlder && target < (state.entries[0]?.seq ?? Infinity) && jumpTries.current < 60) {
      jumpTries.current++;
      void loadOlder();
    } else if (!state.hasOlder && state.entries.length) {
      jumpSeq.current = null; // older than anything retained; give up quietly
    }
  }, [state.entries, state.hasOlder, state.status, loadOlder, loadingOlder, jumpVersion, allShown]);

  // Follow new output while you're at the bottom; keep your place when you scrolled up,
  // and when older blocks are prepended (a page from the server, or the backlog drawn in).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = shown[0] ? parseInt(shown[0].key, 10) : undefined;
    // Your own message brings you back down to it.
    if (outgoing.length > prevOut.current) stick.current = true;
    prevOut.current = outgoing.length;
    if (prevFirst.current !== undefined && first !== undefined && first < prevFirst.current && !stick.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = el.scrollHeight;
    prevFirst.current = first;
  }, [shown, outgoing.length, w.status, hidden]);

  const onScroll = () => {
    const el = scroller.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = atBottom;
    setAway(!atBottom);
    if (el.scrollTop < 200 && allShown && state.hasOlder && !loadingOlder) loadOlder();
  };

  const waiting = w.status === 'waiting' && w.ask;
  const empty = state.status !== 'unavailable' && !blocks.length;
  // A session nothing has been said in yet (its transcript starts with the first message).
  const blank = !!recent && !blocks.length && !outgoing.length && w.status === 'idle' && (state.status === 'live' || state.reason === 'no-transcript');

  // Staying at the bottom also holds when the space changes under the feed: the queue
  // tray or a phone keyboard shortens it, and a waiting call opens its diff after render.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const follow = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    follow.observe(el);
    // Border boxes: a phone's growing draft only pads the feed (--mobile-composer-height).
    for (const child of Array.from(el.children)) follow.observe(child, { box: 'border-box' });
    return () => follow.disconnect();
  }, [empty]);
  // What a waiting agent asks about is the newest call still without a result in this turn: the
  // command or edit a permission prompt is for, or the question it put to you. Each reads "Waiting for you".
  const awaitingCall = useMemo(() => {
    if (!waiting || !w.ask || w.ask.kind === 'screen') return null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'user') return null;
      if (b.kind !== 'agent') continue;
      for (let j = b.items.length - 1; j >= 0; j--) {
        const it = b.items[j];
        const open = it.kind === 'tools' ? it.calls.findLast((c) => !state.results[c.id]) : undefined;
        if (open) return open.id;
      }
    }
    return null;
  }, [waiting, w.ask?.kind, blocks, state.results]);

  return (
    <GuiContext.Provider value={actions}>
      <AwaitingTool.Provider value={awaitingCall}>
      <TurnLive.Provider value={w.status === 'busy' || w.status === 'waiting'}>
      <div className={`surface gui ${hidden ? 'hidden' : ''}`}>
        <div className="gui-scroll" ref={scroller} onScroll={onScroll}>
          <div
            className="gui-feed"
            onKeyDown={(e) => {
              // Browsing messages (Ctrl+Alt+B): the focused message is the cursor.
              const at = e.target as HTMLElement;
              if (!at.classList.contains('msg') || e.ctrlKey || e.metaKey || e.altKey) return;
              const msgs = [...(scroller.current?.querySelectorAll<HTMLElement>('.msg') ?? [])];
              const i = msgs.indexOf(at);
              const go = (j: number) => {
                const el = msgs[Math.max(0, Math.min(msgs.length - 1, j))];
                el?.focus({ preventScroll: true });
                el?.scrollIntoView({ block: 'nearest' });
              };
              const key = e.key;
              if (key === 'ArrowUp' || key === 'k') go(i - 1);
              else if (key === 'ArrowDown' || key === 'j') go(i + 1);
              else if (key === 'Home') go(0);
              else if (key === 'End') go(msgs.length - 1);
              else if (key === 'c') at.querySelector<HTMLElement>('.msg-copy')?.click();
              else if (key === 'r') at.querySelector<HTMLElement>('.msg-snap')?.click();
              else if (key === 'Escape') onReply();
              else return;
              e.preventDefault();
            }}
          >
            {state.hasOlder && allShown && (
              <button className="btn ghost small gui-older" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Load earlier'}
              </button>
            )}

            {blank ? (
              <Blank agent={w.agent} project={w.project} recent={onResume ? recent : []} onResume={(h) => onResume?.(h)} />
            ) : state.status === 'unavailable' ? (
              <div className="gui-empty">
                <p>{UNAVAILABLE[state.reason ?? ''] ?? 'Nothing to show yet.'}</p>
                <button className="btn small" onClick={onUseTerminal}>
                  Open terminal
                </button>
              </div>
            ) : (
              empty && <div className="gui-empty muted">{state.status === 'connecting' ? 'Connecting…' : 'No messages yet.'}</div>
            )}

            {shown.map((b) => {
              // Snapshot numbers include safety captures and start when ah first
              // runs the session, so a visible-page ordinal is not a turn id.
              const prompt = b.kind === 'user' ? b.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
              const snap = b.kind === 'user' && b.at ? snaps.filter((s) => s.kind === 'turn' && Math.abs(s.createdAt * 1000 - b.at) < 15_000 && (!s.promptExcerpt || s.promptExcerpt === prompt)).sort((a, c) => Math.abs(a.createdAt * 1000 - b.at) - Math.abs(c.createdAt * 1000 - b.at))[0] : undefined;
              return <BlockView key={b.key} block={b} results={state.results} agent={w.agent} snap={snap} onRestore={restoreSnap} freshAfter={freshAfter.current ?? Infinity} />;
            })}

            {outgoing.map((o) => (
              <div key={o.id} className="msg user pending" data-out={o.id}>
                <div className="bubble"><UserText text={o.text} /></div>
                <div className="msg-meta">
                  <span className="msg-time">{o.state === 'sending' ? 'Sending…' : time(o.at)}</span>
                </div>
              </div>
            ))}

            {waiting && (
              <div className="approval">
                <AskPanel ref={askRef} w={w} client={client} onAnswer={onAnswer} onReply={onReply} onUseTerminal={onUseTerminal} />
              </div>
            )}
            {w.status === 'busy' && <Working detail={w.detail} />}

          </div>
        </div>
        {railItems.length > 1 && (
          <MessageRail
            items={railItems}
            scroller={scroller}
            onJump={() => (stick.current = false)}
            onSeek={(seq) => {
              jumpSeq.current = seq; jumpTries.current = 0; jumpTop.current = true;
              setJumpVersion((n) => n + 1);
            }}
          />
        )}
        {away && (
          <button className="gui-latest" onClick={jumpLatest}>
            <Icon name="arrow-down" size={16} />
            Latest
          </button>
        )}
        {state.status === 'connecting' && blocks.length > 0 && <div className="gui-conn">Reconnecting…</div>}
      </div>
      </TurnLive.Provider>
      </AwaitingTool.Provider>
    </GuiContext.Provider>
  );
});

export default GuiSurface;
