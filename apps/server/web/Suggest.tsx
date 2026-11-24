import { useEffect, useRef, useState } from 'react';
import type { HostApi, SlashCommand, Win } from './api.ts';

// Composer autocomplete. "/" at the start of a message lists the agent's slash
// commands (yours and the project's included); "@" lists files in the session's
// project; "#" lists live sessions (sub-sessions & same-Space sessions first) to
// insert a linkable session reference (`#<uid>`). Arrows move, Tab or Enter accepts,
// Escape closes. The text box keeps focus the whole time, so typing never stops.

export type Trigger = { kind: 'slash' | 'file' | 'session'; query: string; start: number; end: number };

/** What the caret is completing, if anything. */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = before.match(/^\/([\w:.-]*)$/);
  if (slash) return { kind: 'slash', query: slash[1], start: 0, end: caret };
  const at = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (at) return { kind: 'file', query: at[1], start: caret - at[1].length - 1, end: caret };
  const hash = before.match(/(?:^|\s)#([^\s#]*)$/);
  if (hash) return { kind: 'session', query: hash[1], start: caret - hash[1].length - 1, end: caret };
  return null;
}

export type Item = { value: string; label: string; detail?: string };

const commandCache = new Map<string, Promise<SlashCommand[]>>();

function rankCommands(list: SlashCommand[], q: string): Item[] {
  const query = q.toLowerCase();
  return list
    .map((c) => {
      const name = c.name.toLowerCase();
      const s = !query ? 1 : name.startsWith(query) ? 3 : name.includes(query) ? 2 : c.description.toLowerCase().includes(query) ? 1 : 0;
      return { c, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
    .map(({ c }) => ({ value: `/${c.name} `, label: `/${c.name}`, detail: [c.description, c.source === 'built-in' ? '' : c.source].filter(Boolean).join(' · ') }));
}

function rankSessions(sessions: Win[], q: string, currentUid: string, currentSpace?: string): Item[] {
  const query = q.toLowerCase();
  return sessions
    .filter((s) => s.uid !== currentUid)
    .map((s) => {
      const title = (s.title || s.name).toLowerCase();
      const space = (s.space || s.project || '').toLowerCase();
      const uid = s.uid.toLowerCase();
      const textScore = !query ? 1 : title.startsWith(query) ? 4 : title.includes(query) ? 3 : uid.startsWith(query) ? 2 : space.includes(query) ? 1 : 0;
      if (textScore === 0) return { s, score: 0 };
      const isWorker = s.supervision?.managedBy === currentUid ? 20 : 0;
      const sameSpace = currentSpace && (s.space || s.project) === currentSpace ? 10 : 0;
      const isChief = s.supervision?.role === 'chief' ? 2 : 0;
      return { s, score: textScore + isWorker + sameSpace + isChief };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.s.activity - a.s.activity)
    .slice(0, 20)
    .map(({ s }) => {
      const roleTag = s.supervision?.role === 'chief' ? 'Chief' : s.supervision?.managedBy === currentUid ? 'Sub-session' : s.supervision?.role;
      const detail = [roleTag, s.space || s.project, s.agent || 'shell', s.uid].filter(Boolean).join(' · ');
      return { value: `#${s.uid} `, label: s.title || s.name, detail };
    });
}

/**
 * Suggestions for the current trigger. Files are fetched as you type; commands once per session;
 * sessions rank immediately from live state.
 * `dir`: files under that folder instead of the session's (a note, which has no session).
 */
export function useSuggestions(client: HostApi, uid: string, trigger: Trigger | null, dir?: string, sessions?: Win[], currentSpace?: string): Item[] {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const sessionTriggerTick = trigger?.kind === 'session' ? sessions : undefined;
  useEffect(() => {
    const mine = ++seq.current;
    if (!trigger) return setItems([]);
    if (trigger.kind === 'session') {
      setItems(rankSessions(sessionsRef.current ?? [], trigger.query, uid, currentSpace));
      return;
    }
    if (trigger.kind === 'slash') {
      const key = `${uid}`;
      if (!commandCache.has(key)) commandCache.set(key, client.commands(uid).catch(() => []));
      void commandCache.get(key)!.then((list) => mine === seq.current && setItems(rankCommands(list, trigger.query)));
      return;
    }
    const t = setTimeout(() => {
      (dir === undefined ? client.files(uid, trigger.query) : client.fs.complete(dir, trigger.query))
        .then((files) => mine === seq.current && setItems(files.map((f) => ({ value: `@${f} `, label: f.slice(f.lastIndexOf('/') + 1), detail: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '' }))))
        .catch(() => mine === seq.current && setItems([]));
    }, 90);
    return () => clearTimeout(t);
  }, [client, uid, dir, trigger?.kind, trigger?.query, sessionTriggerTick, currentSpace]);
  return items;
}

export function SuggestList({ items, index, onPick, kind }: { items: Item[]; index: number; onPick: (i: number) => void; kind: Trigger['kind'] }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  if (!items.length) return null;
  return (
    <ul ref={list} className="suggest" role="listbox" aria-label={kind === 'slash' ? 'Commands' : kind === 'session' ? 'Sessions' : 'Files'}>
      {items.map((it, i) => (
        <li
          key={it.value}
          role="option"
          aria-selected={i === index}
          className={i === index ? 'on' : ''}
          // Keep focus in the text box: a mousedown would steal it before the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(i)}
        >
          <span className={`suggest-label ${kind === 'slash' ? 'mono' : ''}`}>{it.label}</span>
          {it.detail && <span className="suggest-detail">{it.detail}</span>}
        </li>
      ))}
      <li className="suggest-hint" aria-hidden>
        ↑↓ move · Tab or Enter accept · Esc close
      </li>
    </ul>
  );
}
