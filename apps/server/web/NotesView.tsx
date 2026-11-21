import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { HostApi, State } from './api.ts';
import { age } from './agents.ts';
import { askConfirm } from './ask.tsx';
import { FileUnder, HANDOFF_MAX, HandToSession, SaveAsFile, fileNameFor } from './NoteActions.tsx';
import { focusFirst } from './rove.ts';
import { ActionSheet } from './sheet.tsx';
import { useDismiss } from './useDismiss.ts';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { continueList, noteTitle, type Note, type NotesBook } from './notes.ts';
import { useNotes } from './useNotes.ts';

const toast = (text: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: text }));
const ago = (t: number) => (age(t) === 'now' ? 'just now' : `${age(t)} ago`);
const folder = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

/** #notes, or #notes/<id>: the note open on this page. */
export const notesHash = (id?: string | null) => (id ? `notes/${id}` : 'notes');
function parseNotesHash(hash: string): string | null {
  const m = hash.replace(/^#/, '').match(/^notes\/([0-9a-fA-F-]{36})$/);
  return m ? m[1].toLowerCase() : null;
}

function useOpenNote() {
  const [id, setId] = useState(() => parseNotesHash(location.hash));
  useEffect(() => {
    const on = () => setId(parseNotesHash(location.hash));
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
    };
  }, []);
  /** Opening a note is a history entry (Back goes to the list on a phone); fixing up the current one replaces it. */
  const go = useCallback((next: string | null, opts: { replace?: boolean } = {}) => {
    const entry = { ah: { page: 'notes', selected: null }, back: { page: 'notes', selected: null } };
    const url = `#${notesHash(next)}`;
    if (opts.replace) history.replaceState({ ...history.state, ...entry }, '', url);
    else history.pushState(entry, '', url);
    setId(next);
  }, []);
  return [id, go] as const;
}

/** Notes by project, as the sidebar groups sessions: the unfiled first, then each project by name. */
export function noteGroups(notes: Note[], multiHost: boolean): Array<{ key: string; label: string; notes: Note[] }> {
  const groups = new Map<string, { key: string; label: string; notes: Note[] }>();
  for (const n of notes) {
    const key = n.project ? `${n.project.host}:${n.project.path}` : '';
    const label = n.project ? (multiHost ? `${folder(n.project.path)} · ${n.project.host}` : folder(n.project.path)) : 'Notes';
    if (!groups.has(key)) groups.set(key, { key, label, notes: [] });
    groups.get(key)!.notes.push(n);
  }
  return [...groups.values()].sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : a.label.localeCompare(b.label)));
}

/** Who wrote a note's version (server/notes/api.ts `who`), as you'd say it. */
const writerName = (w: string) => (w.startsWith('device:') ? w.slice(7) : w.startsWith('token:') ? `The ${w.slice(6)} token` : 'The host itself');

/** A saved file's path inside the note's project, or from its folder's name. */
const shortPath = (path: string, project?: string) => (project && path.startsWith(`${project.replace(/\/+$/, '')}/`) ? path.slice(project.replace(/\/+$/, '').length + 1) : path.split('/').slice(-2).join('/'));

const SYNC_WORD = { synced: 'On the host', pending: 'Saved here', conflict: 'Changed elsewhere too', refused: 'Kept here only' } as const;

/** What a note can start: a session there (New session, the note as its first message or a file), or one it's handed to. */
type Props = { state: State; narrow: boolean; client: HostApi; onNewSession: (o: { cwd?: string; host?: string; prompt: string }) => void; onOpenSession: (key: string) => void };

/** Scratchpads (docs/spec/15-scratchpads.md): Markdown notes with no agent behind them. */
export function NotesView({ state, narrow, client, onNewSession, onOpenSession }: Props) {
  const book = useNotes();
  const [openId, go] = useOpenNote();
  const notes = book.list();
  const open = openId ? book.get(book.current(openId)) : null;

  // A note kept under a new id (its edits met a deletion elsewhere): the view follows it.
  useEffect(() => {
    if (openId && !open && book.current(openId) !== openId) go(book.current(openId), { replace: true });
  });
  useEffect(() => {
    for (const n of book.takeNotices()) toast(n);
  });
  // On a wide screen the list sits beside the latest note, so the page is never empty beside it.
  useEffect(() => {
    if (!narrow && !openId && notes[0]) go(notes[0].id, { replace: true });
  }, [narrow, openId, notes[0]?.id]);

  const create = () => {
    const n = book.create();
    go(n.id);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.note-text')?.focus());
  };

  const list = (
    <div className="notes-list">
      {notes.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">No notes yet</p>
          <p className="hint">A note is Markdown you write with no agent behind it: offline too. It's kept on {state.hostname}, so your other devices have it.</p>
          <button className="btn primary" onClick={create}>
            New note
          </button>
        </div>
      ) : (
        noteGroups(notes, state.hosts.length > 1).map((g, _, all) => (
          <section key={g.key || 'none'} className="notes-group">
            {/* Projects get a heading; notes in none, alone, need no "Notes" under the page's own title. */}
            {(g.key || all.length > 1) && (
              <h2 className="section-label">
                <span className="section-name">{g.key ? g.label : 'Not in a Space'}</span> <span className="count">{g.notes.length}</span>
              </h2>
            )}
            <ul className="rows">
              {g.notes.map((n) => {
                const word = book.syncWord(n);
                return (
                  <li key={n.id}>
                    <button className={`row note-row ${open?.id === n.id ? 'on' : ''}`} aria-current={open?.id === n.id || undefined} onClick={() => go(n.id, { replace: !narrow && !!openId })}>
                      <Icon name="note" size={16} />
                      <span className="stack grow">
                        <span className="name">{noteTitle(n)}</span>
                        <span className="sub">
                          {ago(n.updatedAt)}
                          {word !== 'synced' && <span className={`note-sync ${word}`}> · {SYNC_WORD[word]}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );

  return (
    <div className={`page notes-page ${open ? 'has-note' : ''}`} data-title="Notes">
      {(!narrow || !open) && (
        <header className="page-head">
          <div className="grow">
            <h1 className="page-title">
              Notes<span className="period">.</span>
            </h1>
            <p className="tagline">Think it through here, then hand it to an agent or save it in a Space.</p>
          </div>
          <button className="btn primary" onClick={create}>
            New note
          </button>
        </header>
      )}
      <div className="notes-body">
        {(!narrow || !open) && list}
        {open && <NoteEditor key={open.id} note={open} book={book} narrow={narrow} offline={book.offline} state={state} client={client} onNewSession={onNewSession} onOpenSession={onOpenSession} onBack={() => (history.state?.back?.page === 'notes' ? history.back() : go(null, { replace: true }))} onGone={() => go(null, { replace: true })} onOpen={(id) => go(id)} />}
      </div>
    </div>
  );
}

type EditorProps = Omit<Props, 'narrow'> & { note: Note; book: NotesBook; narrow: boolean; offline: boolean; onBack: () => void; onGone: () => void; onOpen: (id: string) => void };

function NoteEditor({ note, book, narrow, offline, state, client, onNewSession, onOpenSession, onBack, onGone, onOpen }: EditorProps) {
  const [preview, setPreview] = useState(false);
  const [sheet, setSheet] = useState<'send' | 'box' | 'file' | 'project' | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  /** The caret after a carried-on list, set once React has drawn the new text. */
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || !text.current) return;
    text.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  const word = book.syncWord(note);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const next = continueList(el.value, el.selectionStart, el.selectionEnd);
    if (!next) return;
    e.preventDefault();
    caret.current = next.caret;
    book.edit(note.id, { markdown: next.text });
  };

  /** New session there: the project and host chosen, the note its first message, or a Markdown file of it when long. */
  const startSession = async () => {
    let prompt = note.markdown;
    if (prompt.length > HANDOFF_MAX) {
      try {
        const path = await client.upload(new File([note.markdown], fileNameFor(noteTitle(note)), { type: 'text/markdown' }));
        prompt = `${path} ${noteTitle(note)}`;
      } catch {
        toast("Couldn't attach the note; it's in the box as words instead.");
      }
    }
    onNewSession({ cwd: note.project?.path, host: note.project?.host, prompt });
  };

  const remove = async () => {
    if (note.markdown.trim() && !(await askConfirm({ title: `Delete “${noteTitle(note)}”?`, body: 'It goes from every device.', confirm: 'Delete', danger: true }))) return;
    book.remove(note.id);
    onGone();
  };

  return (
    <article className="note-editor" aria-label={noteTitle(note)}>
      <div className="note-bar">
        {narrow && (
          <button className="icon-btn" onClick={onBack} aria-label="Notes">
            <Icon name="back" />
          </button>
        )}
        <input className="note-title" value={note.title} placeholder={noteTitle({ title: '', markdown: note.markdown })} aria-label="Title" maxLength={200} onChange={(e) => book.edit(note.id, { title: e.target.value })} />
        <div className="seg" role="radiogroup" aria-label="Show">
          <button role="radio" aria-checked={!preview} className={preview ? '' : 'on'} onClick={() => setPreview(false)}>
            Edit
          </button>
          <button role="radio" aria-checked={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
        <button className="icon-btn" title="Send to an agent" aria-label="Send to an agent" disabled={!note.markdown.trim()} onClick={() => setSheet('send')}>
          <Icon name="send" />
        </button>
        <NoteMenu
          narrow={narrow}
          items={[
            { label: 'Send to an Agent…', icon: 'send', off: !note.markdown.trim(), run: () => setSheet('send') },
            { label: "Put in a Session's Box…", icon: 'reply', off: !note.markdown.trim(), run: () => setSheet('box') },
            { label: 'Start a Session from This…', icon: 'plus', off: !note.markdown.trim(), run: () => void startSession() },
            null,
            { label: 'Save as File…', icon: 'file', off: !note.markdown.trim(), run: () => setSheet('file') },
            { label: note.project ? `Space: ${note.project.path.split('/').pop()}…` : 'File Under a Space…', icon: 'files', run: () => setSheet('project') },
            null,
            {
              label: 'Duplicate',
              icon: 'copy',
              run: () => {
                const copy = book.duplicate(note.id);
                if (copy) onOpen(copy.id);
              },
            },
            { label: 'Delete', icon: 'trash', danger: true, run: () => void remove() },
          ]}
        />
      </div>
      {note.conflict && (
        <div className="note-conflict" role="alert">
          <p>
            <strong>Changed on another device too.</strong> {writerName(note.conflict.writer)} changed it {ago(note.conflict.updatedAt)}, while this one had changes of its own. Nothing was merged: choose which to keep.
          </p>
          <details>
            <summary>Their version</summary>
            <pre className="note-theirs">{note.conflict.markdown}</pre>
          </details>
          <div className="note-conflict-actions">
            <button className="btn small primary" onClick={() => book.resolve(note.id, 'mine')}>
              Keep mine
            </button>
            <button className="btn small" onClick={() => book.resolve(note.id, 'theirs')}>
              Keep theirs
            </button>
            <button className="btn small ghost" onClick={() => book.resolve(note.id, 'both')}>
              Keep both
            </button>
          </div>
        </div>
      )}
      {preview ? (
        <div className="note-preview">{note.markdown.trim() ? <Markdown text={note.markdown} /> : <p className="hint">Nothing written yet.</p>}</div>
      ) : (
        <textarea
          ref={text}
          className="note-text"
          aria-label="Note"
          spellCheck
          placeholder="Write in Markdown…"
          value={note.markdown}
          onChange={(e) => book.edit(note.id, { markdown: e.target.value })}
          onKeyDown={onKey}
        />
      )}
      <footer className="note-foot">
        <span className={`note-sync ${word}`} role="status">
          {word === 'refused' ? note.error : word === 'pending' && offline ? "Saved here; it goes to the host once it's back" : SYNC_WORD[word]}
        </span>
        <span className="grow" />
        {note.exports.length > 0 && <span className="meta">Saved as {shortPath(note.exports.at(-1)!.path, note.project?.path)}</span>}
        <span className="meta">Edited {ago(note.updatedAt)}</span>
      </footer>
      {(sheet === 'send' || sheet === 'box') && <HandToSession note={note} state={state} client={client} mode={sheet} onClose={() => setSheet(null)} onOpenSession={onOpenSession} />}
      {sheet === 'file' && <SaveAsFile note={note} state={state} client={client} book={book} onClose={() => setSheet(null)} />}
      {sheet === 'project' && <FileUnder note={note} state={state} client={client} book={book} onClose={() => setSheet(null)} />}
    </article>
  );
}

type MenuItem = { label: string; icon: Parameters<typeof Icon>[0]['name']; run: () => void; off?: boolean; danger?: boolean } | null;

/** The note's ••• menu: a dropdown on a desktop, an action sheet on a phone. */
function NoteMenu({ items, narrow }: { items: MenuItem[]; narrow: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(open && !narrow, wrap, () => setOpen(false));
  useEffect(() => {
    if (open && !narrow) requestAnimationFrame(() => focusFirst(menu.current));
  }, [open, narrow]);
  const body = (
    <div ref={menu} data-rove role="menu" aria-label="Note" className={narrow ? 'menu sheet' : 'menu note-menu'} style={narrow ? { margin: 0 } : undefined}>
      {items.map((it, i) =>
        it ? (
          <button
            key={it.label}
            role="menuitem"
            className={it.danger ? 'danger' : ''}
            disabled={it.off}
            onClick={() => {
              setOpen(false);
              it.run();
            }}
          >
            <span className="grow">{it.label}</span>
            <Icon name={it.icon} size={16} />
          </button>
        ) : (
          <hr key={`sep${i}`} />
        ),
      )}
    </div>
  );
  return (
    <span className="menu-wrap" ref={wrap}>
      <button className="icon-btn" title="More" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (narrow ? createPortal(<ActionSheet onClose={() => setOpen(false)}>{body}</ActionSheet>, document.body) : body)}
    </span>
  );
}
