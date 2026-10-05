// The session as a GUI: a separate component tree that never touches the terminal.
// It renders the agent's typed event stream (server/feed) and talks back through
// the same send/answer API the terminal path uses.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ToolResult } from '../../server/feed/schema.ts';
import type { SurfaceHandle, SurfaceProps } from '../surface.ts';
import { showError } from '../ask.tsx';
import { look } from '../agents.ts';
import { AgentLogo } from '../logos.tsx';
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

function BlockView({ block, results, agent }: { block: Block; results: Record<string, ToolResult>; agent: string | null }) {
  if (block.kind === 'notice') return <PartView part={block.part} />;
  if (block.kind === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">
          {block.parts.map((p, i) => (
            <PartView key={i} part={p} />
          ))}
        </div>
        <span className="msg-time">{time(block.at)}</span>
      </div>
    );
  }
  return (
    <div className="msg agent">
      <span className="chip sm" style={{ '--agent': look(agent).color } as React.CSSProperties}>
        <AgentLogo id={agent} size={13} />
      </span>
      <div className="turn">
        {block.items.map((item) => (
          <ItemView key={item.key} item={item} results={results} />
        ))}
      </div>
    </div>
  );
}

const GuiSurface = forwardRef<SurfaceHandle, SurfaceProps>(function GuiSurface({ w, client, hidden, onAnswer, onReply, onUseTerminal }, ref) {
  const { state, loadOlder, loadingOlder } = useFeed(client, w.uid);
  const blocks = useMemo(() => project(state.entries), [state.entries]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const prevHeight = useRef(0);
  const prevFirst = useRef<number | undefined>(undefined);

  // Typing into the agent's input goes through the same path as the terminal.
  useImperativeHandle(ref, () => ({
    insert: (text) => void client.send(w.uid, text, false).catch((e) => showError(e, "Couldn't send")),
    focus: onReply,
  }));

  const actions = useMemo<GuiActions>(
    () => ({
      reply: (text) => void client.send(w.uid, text, true).catch((e) => showError(e, "Couldn't send")),
      fileUrl: (path) => client.fs.url(path),
      resolvePath: (p) => (p.startsWith('/') || p.startsWith('~') ? p : `${w.cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`),
    }),
    [client, w.uid, w.cwd],
  );

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

  // A rebuilt projection is a new conversation: start at its end.
  useEffect(() => {
    stick.current = true;
  }, [state.epoch]);

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

            {blocks.map((b) => (
              <BlockView key={b.key} block={b} results={state.results} agent={w.agent} />
            ))}

            {waiting && (
              <div className="approval">
                <span className="card-kind">{w.ask!.kind === 'question' ? 'Asked a question' : 'Needs your approval'}</span>
                {w.ask!.text && w.ask!.kind !== 'screen' && <pre className="code-block">{w.ask!.text}</pre>}
                <div className="actions">
                  {w.answerable ? (
                    <>
                      <button className="btn primary" onClick={() => onAnswer(w, 'approve')}>
                        Approve
                      </button>
                      <button className="btn" onClick={() => onAnswer(w, 'deny')}>
                        Deny
                      </button>
                    </>
                  ) : (
                    <button className="btn primary" onClick={onReply}>
                      Reply
                    </button>
                  )}
                  {/* The agent's own picker lives in its TUI. */}
                  <button className="btn ghost" onClick={onUseTerminal}>
                    Answer in terminal
                  </button>
                </div>
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
