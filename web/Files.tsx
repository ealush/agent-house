import { useEffect, useRef, useState } from 'react';
import { shellQuote, type FsEntry, type FsListing, type HostApi } from './api.ts';

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
  onClose: () => void;
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

export function FilesDialog({ fs, start, cwd, agent, onInsert, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [path, setPath] = useState(start);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text?: string } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState(() => MENTION_AGENTS.has(agent ?? ''));
  const crumbsRef = useRef<HTMLElement>(null);

  useEffect(() => ref.current?.showModal(), []);

  const load = (p = path) => {
    setError(null);
    fs.list(p, hidden)
      .then((l) => {
        setListing(l);
        setPath(l.path);
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => load(path), [path, hidden]);

  function insert(abs: string) {
    const rel = relativeTo(cwd, abs);
    onInsert(mention ? `@${rel} ` : `${shellQuote(rel)} `);
    onClose();
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
      setError((e as Error).message);
    } finally {
      setUploading(null);
      load();
    }
    return done;
  }

  async function newFolder() {
    const name = prompt('New folder name')?.trim();
    if (!name || !listing) return;
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
    <dialog
      ref={ref}
      className="dialog files-dialog"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
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
      <div className="capture-head">
        <h2>Files</h2>
        <label className="btn small primary">
          {uploading ? `Uploading ${uploading}…` : 'Upload here'}
          <input type="file" multiple hidden onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
        </label>
        <button className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="fs-bar">
        <button className="btn ghost small" disabled={!listing?.parent} onClick={() => listing?.parent && setPath(listing.parent)} title="Up">
          ↑
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
        <span className="spacer" />
        <button className="btn ghost small" onClick={() => setPath(cwd)} title="Session folder">
          ⌂ session
        </button>
        <button className={`btn ghost small ${hidden ? 'on' : ''}`} onClick={() => setHidden(!hidden)} title="Show dotfiles">
          .*
        </button>
        <button className="btn ghost small" onClick={newFolder} title="New folder">
          ＋📁
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
          <span>Insert as @mention (for agents)</span>
        </label>
        <span className="spacer" />
        <button className="btn small" onClick={() => insert(listing?.path ?? path)}>
          Insert this folder
        </button>
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
    </dialog>
  );
}
