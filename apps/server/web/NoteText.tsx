// A note's text with what it carries (docs/spec/15-scratchpads.md, SCR-7), as a session's box
// has it (Composer.tsx): "@path" files as chips, with the @ completion, and pictures and files
// uploaded to the host, each a tile over the text and a chip where it was put. Pasted, dropped
// or picked, they upload at once. The note keeps each as its path on the host (noteText.ts),
// so whatever takes the note on (an agent, a new session, a saved file) gets the files too.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { showError } from './ask.tsx';
import { shellQuote, type HostApi } from './api.ts';
import { AttachmentTiles, attachmentChips, thumbnail, type Attachment } from './attachments.tsx';
import { clipboardFiles } from './clipboard.ts';
import { FilePreview } from './FilePreview.tsx';
import { Pictures } from './gui/Gallery.tsx';
import './gui/gui.css';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { MentionLayer, TEXT_LAYOUT, type Chip } from './MentionLayer.tsx';
import { findMentions, MENTION_HREF, moveMention, remarkMentions, removeMention, resolveMention, useFileMentions } from './mentions.ts';
import { noteMarkdown, shownText, tokenPaths } from './noteText.ts';
import { continueList, type Note, type NotesBook } from './notes.ts';
import { SuggestList, triggerAt, useSuggestions } from './Suggest.tsx';
import { uploadToken } from './uploads.ts';
import { useFileDrop } from './useFileDrop.ts';

const toast = (text: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: text }));

let uploadSeq = 0;
/** Uploads whose tile was taken out before they finished: not put in the note when they do. */
const dropped = new Set<number>();

/** What a note carries, and its text as its editor shows it. One per open note. */
export type NoteFiles = ReturnType<typeof useNoteFiles>;

export function useNoteFiles(note: Note, book: NotesBook, client: HostApi) {
  // Path → token while the note is open, so a chip keeps its name (noteText.ts).
  const known = useRef(new Map<string, string>()).current;
  const ids = useRef(new Map<string, number>()).current;
  // On their way: a token in the text ("@paste.png" as written), and a tile.
  const [pending, setPending] = useState<Attachment[]>([]);
  const shown = shownText(note.markdown, known, pending.map((p) => p.token!));
  const paths = tokenPaths(known, shown.uploads);
  const idOf = (token: string) => ids.get(token) ?? (ids.set(token, ++uploadSeq), uploadSeq);
  const tiles: Attachment[] = [
    ...shown.uploads.map((u) => ({ id: idOf(u.token), name: u.name, image: u.image, path: u.path, token: u.token, src: u.image ? client.fs.url(u.path) : undefined })),
    ...pending,
  ];

  /** The note from its editor's text, each upload's path back in its token's place. */
  const write = (text: string) => book.edit(note.id, { markdown: noteMarkdown(text, paths) });

  /** An upload done (its path) or failed (null): its token in the note becomes the path, or goes. */
  function settle(id: string, file: Attachment, path: string | null) {
    setPending((l) => l.filter((x) => x.id !== file.id));
    if (dropped.delete(file.id)) return;
    // The note as it is now, which may no longer be open here.
    const n = book.get(book.current(id));
    const m = n && findMentions(n.markdown).find((x) => x.path === file.token);
    if (!n || !m) return;
    book.edit(n.id, { markdown: path ? n.markdown.slice(0, m.start) + shellQuote(path) + n.markdown.slice(m.end) : removeMention(n.markdown, m).text });
  }

  /** Files into the note, each its token at `at` (in the shown text), uploading behind it. Where the caret goes. */
  function attach(list: File[], at: number): number {
    const taken = new Set([...known.values(), ...shown.uploads.map((u) => u.token), ...pending.map((p) => p.token!)]);
    const added: Attachment[] = list.map((f) => {
      const name = f.name || 'paste.png';
      return { id: ++uploadSeq, name, image: f.type.startsWith('image/'), token: uploadToken(name, taken) };
    });
    const text = shown.text;
    const tokens = added.map((a) => `@${a.token}`).join(' ');
    const i = Math.min(at, text.length);
    const pad = i > 0 && !/\s/.test(text[i - 1]) ? ' ' : '';
    write(`${text.slice(0, i)}${pad}${tokens}${text[i] === ' ' ? '' : ' '}${text.slice(i)}`);
    setPending((l) => [...l, ...added]);
    const id = note.id;
    list.forEach((f, k) => {
      const a = added[k];
      if (a.image) thumbnail(f).then((src) => setPending((l) => l.map((x) => (x.id === a.id ? { ...x, src } : x))), () => {});
      client.upload(f).then(
        (path) => {
          known.set(path, a.token!);
          settle(id, a, path);
        },
        (e) => {
          settle(id, a, null);
          showError(e, `Couldn't attach ${a.name}`);
        },
      );
    });
    return i + pad.length + tokens.length + 1;
  }

  /** A file taken out (its tile's ×), and its chip with it. Where the caret goes, if it had one. */
  function remove(file: Attachment): number | undefined {
    if (!file.path) {
      dropped.add(file.id);
      setPending((l) => l.filter((x) => x.id !== file.id));
    }
    const chip = attachmentChips([file], shown.text)[0];
    if (!chip) return undefined;
    const next = removeMention(shown.text, chip);
    write(next.text);
    return next.caret;
  }

  return { shown, tiles, write, attach, remove, uploading: pending.length > 0 };
}

/** Where a list of suggestions goes: under the caret's line, or over it near the box's foot. */
function caretPlace(box: HTMLTextAreaElement, at: number): { top: number; above: boolean } {
  const style = getComputedStyle(box);
  const mirror = document.createElement('div');
  for (const k of TEXT_LAYOUT) mirror.style[k] = style[k];
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', boxSizing: 'border-box', width: `${box.clientWidth}px`, whiteSpace: 'pre-wrap' });
  mirror.textContent = box.value.slice(0, at);
  const mark = document.createElement('span');
  mark.textContent = '​';
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const line = mark.offsetTop - box.scrollTop;
  const height = mark.offsetHeight;
  mirror.remove();
  const above = line > box.clientHeight * 0.6;
  return { top: box.offsetTop + (above ? line - 4 : line + height + 4), above };
}

export type NoteTextHandle = { attach: (files: File[]) => void };

type TextProps = {
  files: NoteFiles;
  client: HostApi;
  /** Where its "@path"s are, and what the @ completion lists: its Space's folder, else home. */
  dir: string;
  /** A note in no Space completes to whole paths: whoever takes it on works somewhere else. */
  absolute: boolean;
};

/** The note's text: a native textarea (dictation, autocorrect, selection) with its chips over it. */
export const NoteText = forwardRef<NoteTextHandle, TextProps>(function NoteText({ files, client, dir, absolute }, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  const text = files.shown.text;
  /** The caret after a change made here, set once React has drawn the new text. */
  const caretTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caretTo.current === null || !area.current) return;
    area.current.setSelectionRange(caretTo.current, caretTo.current);
    caretTo.current = null;
  });
  const [caret, setCaret] = useState(0);
  const syncCaret = () => setCaret(area.current?.selectionStart ?? 0);
  const set = (next: { text: string; caret: number }) => {
    caretTo.current = next.caret;
    setCaret(next.caret);
    files.write(next.text);
  };

  // The @ completion: files in the note's folder (a note has no "/" commands).
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [pick, setPick] = useState(0);
  const raw = triggerAt(text, caret);
  const typed = raw?.kind === 'file' ? raw : null;
  const trigger = typed && typed.start !== dismissed ? typed : null;
  const found = useSuggestions(client, '', trigger, dir);
  const suggestions = absolute ? found.map((it) => ({ ...it, value: `@${dir.replace(/\/+$/, '')}/${it.value.slice(1)}` })) : found;
  const suggesting = !!trigger && suggestions.length > 0;
  useEffect(() => setPick(0), [trigger?.query]);
  const [place, setPlace] = useState<{ top: number; above: boolean } | null>(null);
  useLayoutEffect(() => setPlace(suggesting && area.current ? caretPlace(area.current, trigger.start) : null), [suggesting, trigger?.start, text]);
  function accept(i: number) {
    const item = suggestions[i];
    if (!item || !trigger) return;
    set({ text: text.slice(0, trigger.start) + item.value + text.slice(trigger.end), caret: trigger.start + item.value.length });
    area.current?.focus();
  }

  // Chips: the files the text names that are there, and what it carries; not the one being completed.
  const typing = typed?.start;
  const tokens = new Set(files.tiles.map((f) => f.token));
  const mentions = useFileMentions(client.fs, dir, text, typing);
  const chips: Chip[] = [...mentions.filter((m) => !tokens.has(m.path)), ...attachmentChips(files.tiles, text).filter((m) => m.start !== typing)].sort((a, b) => a.start - b.start);
  const [preview, setPreview] = useState<string | null>(null);
  function openChip(m: Chip) {
    if (!m.file) return setPreview(resolveMention(dir, m.path));
    if (m.file.path) setPreview(m.file.path);
    else toast(`${m.file.name} is still uploading`);
  }
  function dropChip(m: Chip) {
    if (!m.file) return set(removeMention(text, m));
    const at = files.remove(m.file);
    if (at !== undefined) caretTo.current = at;
  }

  function attach(list: File[]) {
    if (!list.length) return;
    caretTo.current = files.attach(list, area.current?.selectionStart ?? text.length);
    area.current?.focus();
  }
  useImperativeHandle(ref, () => ({ attach }));
  const drop = useFileDrop(attach);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari can report the final IME Enter as keyCode 229 after isComposing clears.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (suggesting) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        accept(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(trigger.start);
        return;
      }
    }
    // Return in a list item starts the next item; on an empty item it ends the list.
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    const el = e.currentTarget;
    const next = continueList(el.value, el.selectionStart, el.selectionEnd);
    if (!next) return;
    e.preventDefault();
    set(next);
  };

  return (
    <div className={`note-input ${drop.over ? 'drop' : ''}`} {...drop.handlers}>
      <AttachmentTiles
        files={files.tiles}
        onRemove={(id) => {
          const f = files.tiles.find((x) => x.id === id);
          const at = f && files.remove(f);
          if (at !== undefined) caretTo.current = at;
        }}
      />
      <div className="note-box">
        <textarea
          ref={area}
          className={`note-text ${chips.length ? 'has-mentions' : ''}`}
          aria-label="Note"
          spellCheck
          placeholder="Write in Markdown… @ names a file; paste or drop pictures and files"
          value={text}
          onChange={(e) => {
            files.write(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyDown={onKey}
          onPaste={(e) => {
            // Screenshots often arrive via items with an empty files list.
            const pasted = clipboardFiles(e.clipboardData);
            if (pasted.length) {
              e.preventDefault();
              attach(pasted);
            }
          }}
        />
        {chips.length > 0 && <MentionLayer area={area} text={text} mentions={chips} onOpen={openChip} onRemove={dropChip} onMove={(m, to) => set(moveMention(text, m, to, chips.filter((c) => c.start !== m.start)))} />}
        {suggesting && place && (
          <div className={`note-suggest ${place.above ? 'above' : ''}`} style={{ top: place.top }}>
            <SuggestList items={suggestions} index={pick} kind="file" onPick={accept} />
          </div>
        )}
      </div>
      {preview && <FilePreview fs={client.fs} path={preview} onClose={() => setPreview(null)} />}
    </div>
  );
});

/** A picture's chip in the preview: its place among the note's pictures, not a path. */
const PICTURE = 'ah-picture:';

/** The note read: its pictures and files over it (opening in the gallery and the preview), each a chip where it was put. */
export function NotePreview({ markdown, client, dir }: { markdown: string; client: HostApi; dir: string }) {
  const shown = useMemo(() => shownText(markdown, new Map()), [markdown]);
  const images = shown.uploads.filter((u) => u.image);
  const docs = shown.uploads.filter((u) => !u.image);
  const [open, setOpen] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const tokens = new Set(shown.uploads.map((u) => u.token));
  const found = useFileMentions(client.fs, dir, shown.text).filter((m) => !tokens.has(m.path));
  const links = new Map(found.map((m) => [m.path, resolveMention(dir, m.path)] as const));
  for (const u of docs) links.set(u.token, u.path);
  images.forEach((u, i) => links.set(u.token, `${PICTURE}${i}`));
  const key = [...links].map(([k, v]) => `${k}\t${v}`).sort().join('\n');
  const plugins = useMemo(() => (key ? [remarkMentions(new Map(key.split('\n').map((l) => l.split('\t') as [string, string])))] : undefined), [key]);
  const a = ({ href = '', children }: { href?: string; children?: ReactNode }) => {
    if (!href.startsWith(MENTION_HREF)) return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    const to = decodeURIComponent(href.slice(MENTION_HREF.length));
    const at = to.startsWith(PICTURE) ? Number(to.slice(PICTURE.length)) : null;
    return (
      <a className="mention-chip" href={at === null ? client.fs.url(to) : client.fs.url(images[at].path)} title={at === null ? to : images[at].name} onClick={(e) => {
        // A new tab with a modifier; the gallery or the preview with a plain click or tap.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        if (at === null) setPreview(to);
        else setOpen(at);
      }}>
        {children}
      </a>
    );
  };
  return (
    <>
      {shown.uploads.length > 0 && (
        <div className="gui note-pictures">
          <div className="user-images">
            <Pictures pictures={images.map((u) => ({ src: client.fs.url(u.path), name: u.name }))} open={open} onOpen={setOpen} />
            {docs.map((u) => (
              <button key={u.token} type="button" className="user-file" title={u.path} onClick={() => setPreview(u.path)}>
                <Icon name="file" size={14} /> {u.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <Markdown text={shown.text} plugins={plugins} components={{ a }} />
      {preview && <FilePreview fs={client.fs} path={preview} onClose={() => setPreview(null)} />}
    </>
  );
}
