import { useEffect, useState } from 'react';
import type { ChatMsg, ChatSummary, HostApi } from './api.ts';
import { showNotice } from './ask.tsx';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';

function fmtDate(at: number): string {
  const d = new Date(at * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

// Past side-chat conversations, live sessions and ended ones alike. Read-only:
// the session they belonged to may be gone, so there is nothing to continue.
export function ChatHistory({ client }: { client: HostApi }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<ChatSummary[] | null>(null);
  const [open, setOpen] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<ChatMsg[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setList(null);
    setError(null);
    const t = setTimeout(() => {
      client
        .pastChats(q.trim() || undefined)
        .then(setList)
        .catch((e) => setError(e.message));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, client]);

  async function enter(c: ChatSummary) {
    setError(null);
    try {
      setMessages((await client.pastChat(c.uid)).messages);
      setOpen(c);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      showNotice('Copy failed', 'Select the text and copy it yourself.');
    }
  }

  if (open) {
    return (
      <div className="panel-body sidechat">
        <div className="sidechat-context">
          <button className="icon-btn small" onClick={() => setOpen(null)} aria-label="Back to past chats" title="Back to past chats">
            <Icon name="back" size={14} />
          </button>
          <span className="hint">
            {open.title} · {open.count} messages · {fmtDate(open.lastAt)}
          </span>
        </div>
        {error && <p className="panel-msg">{error}</p>}
        <div className="sidechat-log">
          {(messages ?? []).map((m, i) => (
            <div key={i} className={`sidechat-msg ${m.role}`}>
              <div className="sidechat-bubble">{m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}</div>
              <div className="msg-actions">
                <button className="btn ghost small" onClick={() => copy(m.text)}>
                  Copy
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="panel-body sidechat">
      <div className="sidechat-context">
        <span className="hint">Past chats — read-only</span>
      </div>
      <div className="past-search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search past chats…" aria-label="Search past chats" maxLength={200} />
      </div>
      {error && <p className="panel-msg">{error}</p>}
      <div className="sidechat-log">
        {list === null && !error && <p className="panel-msg">Loading…</p>}
        {list && list.length === 0 && <p className="panel-msg">{q ? 'No past chats match.' : 'No past chats yet.'}</p>}
        {list?.map((c) => (
          <button key={c.uid} className="past-row" onClick={() => enter(c)}>
            <span className="past-title">{c.title}</span>
            <span className="past-meta">
              {fmtDate(c.lastAt)} · {c.count} messages
            </span>
            {c.preview && <span className="past-preview">{c.preview}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
