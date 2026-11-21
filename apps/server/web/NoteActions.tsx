// What a note does beyond being written (docs/spec/15-scratchpads.md SCR-5, SCR-6): handed
// to an agent (sent, or put in its box as a draft), saved as a file in a project, filed
// under one. Handing a note on never changes it.
import { useEffect, useRef, useState } from 'react';
import { ApiError, type HostApi, type NoteHandoff, type State, type Win } from './api.ts';
import { look } from './agents.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { errorText } from './errors.ts';
import { noteTitle, type Note, type NoteProject, type NotesBook } from './notes.ts';
import { SheetBar, useSheet } from './sheet.tsx';

/** The longest text a hand-off sends as words; past it, the note goes as a file (SCR-6). */
export const HANDOFF_MAX = 32_768;
const STATUS = { waiting: 'Needs you', busy: 'Working', attention: 'Done', idle: 'Idle' } as const;
const toast = (text: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: text }));
const folder = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

/** A file name from a note's name: "Release plan" → "release-plan.md". */
export function fileNameFor(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'note'}.md`;
}

/** Every project the host knows of: where sessions run and ran, and its suggestions. Host-aware: one folder name on two hosts is two projects. */
export function knownProjects(state: State, suggested: string[] = []): NoteProject[] {
  const seen = new Map<string, NoteProject>();
  const add = (host: string, path: string) => {
    if (path && path !== '~' && !seen.has(`${host}:${path}`)) seen.set(`${host}:${path}`, { host, path });
  };
  for (const w of state.windows) add(w.host || state.hostname, w.projectPath);
  for (const p of suggested) add(state.hostname, p);
  return [...seen.values()].sort((a, b) => folder(a.path).localeCompare(folder(b.path)) || a.host.localeCompare(b.host));
}

/** The text a session gets: the note itself, or (too long to type) a file of it and its name. */
async function handoffText(note: Note, client: HostApi): Promise<string> {
  if (note.markdown.length <= HANDOFF_MAX) return note.markdown;
  const file = new File([note.markdown], fileNameFor(noteTitle(note)), { type: 'text/markdown' });
  const path = await client.upload(file);
  return `${shellQuote(path)} ${noteTitle(note)}`;
}
const shellQuote = (p: string) => (/^[\w./~@%+=:,-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`);

function sessionLabel(w: Win) {
  return `${w.title} · ${look(w.agent).name} · ${STATUS[w.status]}`;
}

type HandProps = { note: Note; state: State; client: HostApi; mode: 'send' | 'box'; onClose: () => void; onOpenSession: (key: string) => void };

/**
 * Send to an agent (POST /api/notes/handoffs: typed in when idle, queued while it works,
 * resumed when ended), or put the note in a session's box as a draft, asking first when
 * a draft is already there. A send the host can't vouch for comes back as "not sure":
 * Check Again asks by its id; Send It Again only when asked.
 */
export function HandToSession({ note, state, client, mode, onClose, onOpenSession }: HandProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  // This host's agents: a note's hand-off goes through this host (a shell would run the note's lines).
  const agents = state.windows.filter((w) => w.agent && (!w.host || w.host === state.hostname));
  const preferred = agents.find((w) => note.project && w.projectPath === note.project.path) ?? agents[0] ?? null;
  const [uid, setUid] = useState(preferred?.uid ?? '');
  const target = agents.find((w) => w.uid === uid) ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsure, setUnsure] = useState<NoteHandoff | null>(null);
  /** A draft already in the box: Add Below or Replace. */
  const [existing, setExisting] = useState<string | null>(null);
  // One id per send, kept across tries, so a retry is never delivered twice.
  const id = useRef(crypto.randomUUID());
  const sent = useRef<{ target: string; text: string } | null>(null);

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    setExisting(null);
    setError(null);
  }, [uid]);

  const done = (h: NoteHandoff) => {
    if (h.outcome === 'uncertain') return setUnsure(h);
    if (h.outcome === 'failed') return setError(h.error ? `It didn't reach ${target?.title}: ${h.error}` : `It didn't reach ${target?.title}. Nothing was sent; try again.`);
    toast(h.outcome === 'queued' ? `Queued for ${target?.title}` : `Sent to ${target?.title}`);
    onClose();
  };

  async function send(resend = false) {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      // The same target and text on a retry: the host answers from what happened.
      if (!sent.current || sent.current.target !== target.uid) sent.current = { target: target.uid, text: await handoffText(note, client) };
      if (resend) setUnsure(null);
      done(await client.handNote({ id: id.current, noteId: note.id, revision: note.version, target: target.uid, text: sent.current.text, resend }));
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'handoff_too_long' ? 'Too long to send as words.' : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    setBusy(true);
    try {
      done(await client.noteHandoff(id.current));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function putInBox(how: 'ask' | 'below' | 'replace') {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const text = await handoffText(note, client);
      let draft = existing ?? '';
      if (how === 'ask') {
        draft = (await client.draft(target.uid))?.text ?? '';
        if (draft.trim()) {
          setExisting(draft);
          return;
        }
      }
      await client.saveDraft(target.uid, how === 'below' && draft.trim() ? `${draft.replace(/\s+$/, '')}\n\n${text}` : text);
      toast(`In ${target.title}'s box`);
      onClose();
      onOpenSession(target.key);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'send' ? 'Send to an agent' : "Put in a session's box";
  return (
    <dialog ref={dialog} className="dialog new-session" aria-label={title} onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void (mode === 'send' ? send() : putInBox(existing ? 'below' : 'ask'));
        }}
      >
        <header className="ns-head">
          <h2>{title}</h2>
        </header>
        <p className="hint">
          {mode === 'send'
            ? `“${noteTitle(note)}” goes to the session as a message: typed in if it's idle, queued while it works, resumed first if it ended. The note stays as it is.`
            : `“${noteTitle(note)}” goes in the session's box, not sent: you finish it there.`}
          {note.markdown.length > HANDOFF_MAX && ' It is long, so it goes as a Markdown file.'}
        </p>
        {agents.length === 0 ? (
          <p className="form-error">No agent is running on {state.hostname}. Start a session from this note instead.</p>
        ) : (
          <label className="field">
            <span>Session</span>
            <select value={uid} onChange={(e) => setUid(e.target.value)} disabled={!!unsure}>
              {agents.map((w) => (
                <option key={w.uid} value={w.uid}>
                  {sessionLabel(w)}
                  {w.project ? ` · ${w.project}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {existing !== null && (
          <div className="note-ask" role="alert">
            <p>
              <strong>{target?.title} has a draft in its box.</strong> Add the note below it, or replace it?
            </p>
            <pre className="note-theirs">{existing}</pre>
          </div>
        )}
        {unsure && (
          <div className="note-ask" role="alert">
            <p>
              <strong>Not sure it arrived.</strong> The host stopped while sending it to {target?.title}. Look at the session first: sending again could give it the note twice.
            </p>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {unsure ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void checkAgain()}>
                Check Again
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void send(true)}>
                Send It Again
              </button>
            </>
          ) : existing !== null ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void putInBox('replace')}>
                Replace
              </button>
              <ConfirmButton type="submit" className="btn primary" disabled={busy}>
                Add Below
              </ConfirmButton>
            </>
          ) : (
            <ConfirmButton type="submit" className="btn primary" disabled={busy || !target}>
              {mode === 'send' ? (error ? 'Try Again' : 'Send') : 'Put in Box'}
            </ConfirmButton>
          )}
        </div>
      </form>
    </dialog>
  );
}

/**
 * Save as File (POST /api/notes/export): a copy of the note, as it is now, written into a
 * project folder on this host. An existing file is replaced only when you say so.
 */
export function SaveAsFile({ note, state, client, book, onClose }: { note: Note; state: State; client: HostApi; book: NotesBook; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [suggested, setSuggested] = useState<string[]>([]);
  useEffect(() => {
    dialog.current?.showModal();
    client.projects().then(setSuggested, () => {});
  }, [client]);
  // Written on this host: its projects, the note's own first.
  const projects = knownProjects(state, suggested).filter((p) => p.host === state.hostname);
  const [dir, setDir] = useState(note.project?.host === state.hostname ? note.project.path : '');
  const chosen = dir || projects[0]?.path || '';
  const [path, setPath] = useState(() => fileNameFor(noteTitle(note)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState<string | null>(null);

  async function save(replace = false) {
    setBusy(true);
    setError(null);
    try {
      const out = await client.exportNote({ dir: chosen, path: path.trim(), markdown: note.markdown, replace, noteId: note.revision > 0 ? note.id : undefined, revision: note.revision });
      book.recordExport(note.id, { host: state.hostname, path: out.path, revision: note.revision, at: Math.floor(Date.now() / 1000) });
      toast(`Saved as ${out.path}`);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'file_exists') {
        setExists(typeof e.body?.suggestion === 'string' ? e.body.suggestion : null);
        setError(`${path.trim()} is already there.`);
      } else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog new-session" aria-label="Save as file" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header className="ns-head">
          <h2>Save as file</h2>
        </header>
        <p className="hint">A copy of “{noteTitle(note)}” as it is now, written into the project. The note and the file don't keep in step.</p>
        <label className="field">
          <span>Project</span>
          <select value={chosen} onChange={(e) => (setDir(e.target.value), setExists(null), setError(null))}>
            {projects.length === 0 && <option value="">No projects on {state.hostname}</option>}
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {folder(p.path)} · {p.path}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>File</span>
          <input value={path} onChange={(e) => (setPath(e.target.value), setExists(null), setError(null))} placeholder="SPEC.md" spellCheck={false} autoCapitalize="off" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {error && exists !== null ? (
            <>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void save(true)}>
                Replace It
              </button>
              {exists && (
                <button type="button" className="btn primary" disabled={busy} onClick={() => (setPath(exists), setExists(null), setError(null))}>
                  Use {exists}
                </button>
              )}
            </>
          ) : (
            <ConfirmButton type="submit" className="btn primary" disabled={busy || !chosen || !path.trim()}>
              Save
            </ConfirmButton>
          )}
        </div>
      </form>
    </dialog>
  );
}

/** File under a project (metadata only: nothing is written into the folder), or none. */
export function FileUnder({ note, state, client, book, onClose }: { note: Note; state: State; client: HostApi; book: NotesBook; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [suggested, setSuggested] = useState<string[]>([]);
  useEffect(() => {
    dialog.current?.showModal();
    client.projects().then(setSuggested, () => {});
  }, [client]);
  const projects = knownProjects(state, suggested);
  if (note.project && !projects.some((p) => p.host === note.project!.host && p.path === note.project!.path)) projects.unshift(note.project);
  const multiHost = state.hosts.length > 1;
  const keyOf = (p: NoteProject | null) => (p ? `${p.host}\u0000${p.path}` : '');
  const [picked, setPicked] = useState(keyOf(note.project));

  return (
    <dialog ref={dialog} className="dialog new-session" aria-label="Project" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          book.edit(note.id, { project: projects.find((p) => keyOf(p) === picked) ?? null });
          onClose();
        }}
      >
        <header className="ns-head">
          <h2>Project</h2>
        </header>
        <p className="hint">The note is listed with the project's sessions, and starts its sessions there. Nothing is written into the folder.</p>
        <label className="field">
          <span>File under</span>
          <select value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={keyOf(p)} value={keyOf(p)}>
                {folder(p.path)}
                {multiHost ? ` · ${p.host}` : ''} · {p.path}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <ConfirmButton type="submit" className="btn primary">
            Done
          </ConfirmButton>
        </div>
      </form>
    </dialog>
  );
}
