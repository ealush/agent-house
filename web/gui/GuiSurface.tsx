// The session as a GUI: a separate component tree that never touches the terminal.
// It renders the agent's typed event stream (server/feed) and talks back through
// the same send/answer API the terminal path uses.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ToolResult } from '../../server/feed/schema.ts';
import { AskPanel, type AskHandle } from '../AskPanel.tsx';
import type { SurfaceHandle, SurfaceProps } from '../surface.ts';
import type { SnapshotInfo } from '../api.ts';
import { askConfirm, showError, showNotice } from '../ask.tsx';
import { look } from '../agents.ts';
import { AgentLogo } from '../logos.tsx';
import { Icon } from '../icons.tsx';
import { copyText } from '../selection.ts';
import { blockText } from './reducer.ts';
import { useFeed } from './useFeed.ts';
import { project, type Block } from './reducer.ts';
import { GuiContext, type GuiActions } from './context.ts';
import { ItemView, PartView } from './router.tsx';
import './gui.css';

const UNAVAILABLE: Record<string, string> = {
  'no-transcript': 'The conversation will appear here once the agent starts writing it.',
  'no-adapter': 'This agent has no GUI view yet. Use the terminal.',
  'not-found': 'This session is gone.',
};

const time = (at: number) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

/** Hover-only copy action below a message. The row is always laid out (see
 *  gui.css: visibility, not display), so appearing never shifts the feed. */
function MsgCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  if (!text) return null;
  return (
    <div className="msg-actions">
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
    </div>
  );
}

function BlockView({ block, results, agent, snap, onRestore }: { block: Block; results: Record<string, ToolResult>; agent: string | null; snap?: SnapshotInfo; onRestore?: (snap: SnapshotInfo) => void }) {
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
      <div className="msg user" data-seq={seq}>
        <div className="bubble">
          {block.parts.map((p, i) => (
            <PartView key={i} part={p} />
          ))}
        </div>
        <span className="msg-time">{time(block.at)}</span>
        <MsgCopy text={blockText(block)} />
        {snap && (
          <div className="snap-marker">
            <span>Snapshot taken before this turn</span>
            <button className="btn ghost small" onClick={() => onRestore?.(snap)}>
              Restore
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="msg agent" data-seq={seq}>
      <span className="chip sm" style={{ '--agent': look(agent).color } as React.CSSProperties}>
        <AgentLogo id={agent} size={13} />
      </span>
      <div className="turn">
        {block.items.map((item) => (
          <div key={item.key} data-seq={parseInt(item.key, 10)}><ItemView item={item} results={results} /></div>
        ))}
        <MsgCopy text={blockText(block)} />
      </div>
    </div>
  );
}

const GuiSurface = forwardRef<SurfaceHandle, SurfaceProps>(function GuiSurface({ w, client, hidden, onAnswer, onReply, onUseTerminal, refresh }, ref) {
  const { state, loadOlder, loadingOlder } = useFeed(client, w.uid);
  const [snaps, setSnaps] = useState<SnapshotInfo[]>([]);
  useEffect(() => {
    let stopped = false;
    const load = () =>
      client
        .snapshots(w.uid)
        .then((r) => {
          if (!stopped) setSnaps(r.snapshots);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client, w.uid]);

  const restoreSnap = async (snap: SnapshotInfo) => {
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
  const blocks = useMemo(() => project(state.entries), [state.entries]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const prevHeight = useRef(0);
  const prevFirst = useRef<number | undefined>(undefined);

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
    jumpLatest: () => {
      stick.current = true;
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
    },
  }));


  const actions = useMemo<GuiActions>(
    () => ({
      reply: (text) => void client.send(w.uid, text, true).catch((e) => showError(e, "Couldn't send")),
      fileUrl: (path) => client.fs.url(path),
      resolvePath: (p) => (p.startsWith('/') || p.startsWith('~') ? p : `${w.cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`),
    }),
    [client, w.uid, w.cwd],
  );

  // Search jump (issue #9): a result asked for one entry by seq. Page older
  // entries in until it is loaded, then scroll to it and flash it, once.
  const jumpSeq = useRef<number | null>(null);
  const jumpTries = useRef(0);
  const [jumpVersion, setJumpVersion] = useState(0);
  // A rebuilt projection is a new conversation: start at its end.
  useEffect(() => {
    stick.current = jumpSeq.current === null;
  }, [state.epoch]);

  useEffect(() => {
    const accept = (jump: { host?: string; uid?: string; seq?: number }) => {
      if (jump.host !== w.host || jump.uid !== w.uid || typeof jump.seq !== 'number') return;
      sessionStorage.removeItem('ah.seqJump');
      jumpSeq.current = jump.seq; jumpTries.current = 0; stick.current = false;
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
    const el = loaded ? candidates.filter((el) => Number(el.dataset.seq) <= target).sort((a, b) => Number(b.dataset.seq) - Number(a.dataset.seq))[0] : undefined;
    if (el) {
      jumpSeq.current = null;
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
  }, [state.entries, state.hasOlder, state.status, loadOlder, loadingOlder, jumpVersion]);

  // Follow new output while you're at the bottom; keep your place when you scrolled up,
  // and when older entries are prepended.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = state.entries[0]?.seq;
    if (prevFirst.current !== undefined && first !== undefined && first < prevFirst.current && !stick.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = el.scrollHeight;
    prevFirst.current = first;
  }, [state.entries, w.status, hidden]);

  const onScroll = () => {
    const el = scroller.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = atBottom;
    setAway(!atBottom);
    if (el.scrollTop < 200 && state.hasOlder && !loadingOlder) loadOlder();
  };

  const waiting = w.status === 'waiting' && w.ask;
  const empty = state.status !== 'unavailable' && !blocks.length;

  return (
    <GuiContext.Provider value={actions}>
      <div className={`surface gui ${hidden ? 'hidden' : ''}`}>
        <div className="gui-scroll" ref={scroller} onScroll={onScroll}>
          <div className="gui-feed">
            {state.hasOlder && (
              <button className="btn ghost small gui-older" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Load earlier'}
              </button>
            )}

            {state.status === 'unavailable' && (
              <div className="gui-empty">
                <p>{UNAVAILABLE[state.reason ?? ''] ?? 'Nothing to show yet.'}</p>
                <button className="btn small" onClick={onUseTerminal}>
                  Open terminal
                </button>
              </div>
            )}
            {empty && <div className="gui-empty muted">{state.status === 'connecting' ? 'Connecting…' : 'No messages yet.'}</div>}

            {blocks.map((b) => {
              // Snapshot numbers include safety captures and start when ah first
              // runs the session, so a visible-page ordinal is not a turn id.
              const prompt = b.kind === 'user' ? b.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
              const snap = b.kind === 'user' && b.at ? snaps.filter((s) => s.kind === 'turn' && Math.abs(s.createdAt * 1000 - b.at) < 15_000 && (!s.promptExcerpt || s.promptExcerpt === prompt)).sort((a, c) => Math.abs(a.createdAt * 1000 - b.at) - Math.abs(c.createdAt * 1000 - b.at))[0] : undefined;
              return <BlockView key={b.key} block={b} results={state.results} agent={w.agent} snap={snap} onRestore={restoreSnap} />;
            })}

            {waiting && (
              <div className="approval">
                <AskPanel ref={askRef} w={w} client={client} onAnswer={onAnswer} onReply={onReply} onUseTerminal={onUseTerminal} />
              </div>
            )}
            {w.status === 'busy' && (
              <div className="working" aria-live="polite">
                <span className="tool-dot running" /> Working…
              </div>
            )}
          </div>
        </div>
        {away && (
          <button
            className="btn small gui-latest"
            onClick={() => {
              stick.current = true;
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
            }}
          >
            ↓ Latest
          </button>
        )}
        {state.status === 'connecting' && blocks.length > 0 && <div className="gui-conn">Reconnecting…</div>}
      </div>
    </GuiContext.Provider>
  );
});

export default GuiSurface;
