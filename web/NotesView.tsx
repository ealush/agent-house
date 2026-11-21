import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { State } from './api.ts';
import { age } from './agents.ts';
import { askConfirm } from './ask.tsx';
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

const SYNC_WORD = { synced: 'On the host', pending: 'Saved here', conflict: 'Changed elsewhere too', refused: 'Kept here only' } as const;

type Props = { state: State; narrow: boolean };

/** Scratchpads (docs/spec/15-scratchpads.md): Markdown notes with no agent behind them. */
export function NotesView({ state, narrow }: Props) {
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
                <span className="section-name">{g.key ? g.label : 'Not in a project'}</span> <span className="count">{g.notes.length}</span>
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
            <p className="tagline">Think it through here, then hand it to an agent or save it in a project.</p>
          </div>
          <button className="btn primary" onClick={create}>
            New note
          </button>
        </header>
      )}
      <div className="notes-body">
        {(!narrow || !open) && list}
        {open && <NoteEditor key={open.id} note={open} book={book} narrow={narrow} offline={book.offline} onBack={() => (history.state?.back?.page === 'notes' ? history.back() : go(null, { replace: true }))} onGone={() => go(null, { replace: true })} onOpen={(id) => go(id)} />}
      </div>
    </div>
  );
}

function NoteEditor({ note, book, narrow, offline, onBack, onGone, onOpen }: { note: Note; book: NotesBook; narrow: boolean; offline: boolean; onBack: () => void; onGone: () => void; onOpen: (id: string) => void }) {
  const [preview, setPreview] = useState(false);
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
        <button
          className="icon-btn"
          title="Duplicate"
          aria-label="Duplicate"
          onClick={() => {
            const copy = book.duplicate(note.id);
            if (copy) onOpen(copy.id);
          }}
        >
          <Icon name="copy" />
        </button>
        <button className="icon-btn" title="Delete" aria-label="Delete" onClick={() => void remove()}>
          <Icon name="trash" />
        </button>
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
        {note.exports.length > 0 && <span className="meta">Saved as {note.exports.at(-1)!.path}</span>}
        <span className="meta">Edited {ago(note.updatedAt)}</span>
      </footer>
    </article>
  );
}
