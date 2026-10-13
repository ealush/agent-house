import { useEffect, useRef, useState } from 'react';
import { shellQuote, type FsEntry, type FsListing, type HostApi } from './api.ts';
import { askText } from './ask.tsx';
import { Icon } from './icons.tsx';
import { errorText } from './errors.ts';

// File explorer + transfer. Browse the host from the session's folder, pull files
// down to this device, push files up into any folder, and hand a path to the
// session: as an @mention for agents that support it, a quoted path otherwise.
type Props = {
  fs: HostApi['fs'];
  /** Absolute (or ~) folder to open in; usually the session's cwd. */
  start: string;
  /** The session's cwd, so inserted paths can be relative to it. */
  cwd: string;
  agent: string | null;
  onInsert: (text: string) => void;
};

const MENTION_AGENTS = new Set(['claude', 'codex', 'gemini', 'opencode']);

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

const isImage = (name: string) => /\.(png|jpe?g|gif|webp|avif)$/i.test(name);

export function relativeTo(cwd: string, path: string): string {
  if (path === cwd) return '.';
  return path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path;
}

export function FilesPanel({ fs, start, cwd, agent, onInsert }: Props) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [path, setPath] = useState(start);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text?: string } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState(() => MENTION_AGENTS.has(agent ?? ''));
  const [rootList, setRootList] = useState<string[]>([]);
  const crumbsRef = useRef<HTMLElement>(null);

  const load = (p = path) => {
    setError(null);
    fs.list(p, hidden)
      .then((l) => {
        setListing(l);
        setPath(l.path);
        if (l.roots) setRootList(l.roots);
      })
      .catch((e) => {
        setError(e.message);
        // Learn the browsable roots even when this folder is off-limits.
        if (!rootList.length) fs.list('', false).then((l) => setRootList(l.roots ?? [])).catch(() => {});
      });
  };
  useEffect(() => load(path), [path, hidden]);

  function insert(abs: string) {
    const rel = relativeTo(cwd, abs);
    onInsert(mention ? `@${rel} ` : `${shellQuote(rel)} `);
  }

  async function open(e: FsEntry) {
    const abs = `${listing!.path}/${e.name}`.replace(/\/+/g, '/');
    if (e.type === 'dir') return setPath(abs);
    if (isImage(e.name)) return setPreview({ path: abs });
    if (e.size > 1024 * 1024) return setPreview({ path: abs, text: '(too large to preview — download it instead)' });
    const res = await fetch(fs.url(abs));
    const type = res.headers.get('content-type') ?? '';
    setPreview({ path: abs, text: type.startsWith('text/') ? await res.text() : '(binary file — download it instead)' });
  }

  async function uploadFiles(files: FileList | File[]) {
    if (!listing) return;
    const done: string[] = [];
    try {
      for (const f of files) {
        setUploading(f.name);
        done.push(await fs.upload(listing.path, f));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploading(null);
      load();
    }
    return done;
  }

  async function newFolder() {
    if (!listing) return;
    const name = await askText({ title: 'New folder', label: 'Name', placeholder: 'notes', confirm: 'Create' });
    if (!name) return;
    await fs.mkdir(`${listing.path}/${name}`).catch((e) => setError(e.message));
    load();
  }

  const crumbs = (listing?.path ?? path).split('/').filter(Boolean);
  // Long paths: keep the current folder in view, not the root.
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [listing]);

  return (
    <div
      className="fs"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          uploadFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="fs-bar">
        <button className="icon-btn small" disabled={!listing?.parent} onClick={() => listing?.parent && setPath(listing.parent)} title="Up" aria-label="Up">
          <Icon name="up" size={14} />
        </button>
        <nav className="crumbs" aria-label="Path" ref={crumbsRef}>
          <button className="linkish" onClick={() => setPath('/')}>
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              <button className="linkish" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
              {i < crumbs.length - 1 ? '/' : ''}
            </span>
          ))}
        </nav>
        {rootList.length > 0 && (
          <select className="roots" value="" onChange={(e) => e.target.value && setPath(e.target.value)} aria-label="Browsable folders">
            <option value="">Roots…</option>
            {rootList.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        <button className="icon-btn small" onClick={() => setPath(cwd)} title="Session folder" aria-label="Session folder">
          <Icon name="home" size={15} />
        </button>
        <button className={`btn ghost small ${hidden ? 'on' : ''}`} onClick={() => setHidden(!hidden)} title="Show dotfiles">
          .*
        </button>
        <button className="icon-btn small" onClick={newFolder} title="New folder" aria-label="New folder">
          <Icon name="folder-plus" size={15} />
        </button>
      </div>

      <div className="fs-list">
        {error && <p className="form-error">{error}</p>}
        {listing && listing.entries.length === 0 && <p className="hint">Empty folder. Drop files here to upload them.</p>}
        <ul>
          {listing?.entries.map((e) => {
            const abs = `${listing.path}/${e.name}`.replace(/\/+/g, '/');
            return (
              <li key={e.name} className={`fs-row ${e.type}`}>
                <button className="fs-name" onClick={() => open(e)}>
                  <span aria-hidden className="fs-icon">
                    {e.type === 'dir' ? '▸' : isImage(e.name) ? '▣' : '·'}
                  </span>
                  <span className="fs-label">{e.name}</span>
                  {e.type === 'file' && <span className="fs-size">{size(e.size)}</span>}
                </button>
                <button className="btn ghost small" onClick={() => insert(abs)} title={`Insert ${mention ? '@mention' : 'path'} into the session`}>
                  Insert
                </button>
                {e.type === 'file' && (
                  <a className="btn ghost small" href={fs.url(abs, true)} download={e.name} title="Download to this device">
                    ↓
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="fs-foot">
        <label className="check">
          <input type="checkbox" checked={mention} onChange={(e) => setMention(e.target.checked)} />
          <span>@mention</span>
        </label>
        <span className="spacer" />
        <button className="btn ghost small" onClick={() => insert(listing?.path ?? path)}>
          Insert folder
        </button>
        <label className="btn small primary">
          {uploading ? `Uploading ${uploading}…` : 'Upload here'}
          <input type="file" multiple hidden onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
        </label>
      </div>

      {dragging && <div className="drop-hint">Drop to upload into {crumbs.at(-1) ?? '/'}</div>}

      {preview && (
        <div className="fs-preview" onClick={() => setPreview(null)}>
          <div className="fs-preview-card" onClick={(e) => e.stopPropagation()}>
            <div className="capture-head">
              <h2 className="hint">{preview.path}</h2>
              <button className="btn small" onClick={() => insert(preview.path)}>
                Insert
              </button>
              <a className="btn ghost small" href={fs.url(preview.path, true)} download>
                Download
              </a>
              <button className="btn ghost small" onClick={() => setPreview(null)}>
                Close
              </button>
            </div>
            {preview.text !== undefined ? <pre>{preview.text}</pre> : <img src={fs.url(preview.path)} alt="" />}
          </div>
        </div>
      )}
    </div>
  );
}
