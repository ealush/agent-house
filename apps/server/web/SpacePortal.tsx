import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import { FilesPanel } from './Files.tsx';
import { Glide } from './Glide.tsx';
import { Icon } from './icons.tsx';
import { AgentLogo } from './logos.tsx';
import { Markdown } from './Markdown.tsx';
import { HandToSession } from './NoteActions.tsx';
import { age, frontAgents, look } from './agents.ts';
import { canonicalProjectPath } from './inboxProject.ts';
import {
  waitForWindow,
  type FleetTask,
  type FleetTaskStatus,
  type HostApi,
  type Job,
  type MemoryFile,
  type SpaceContext,
  type SpaceView,
  type State,
  type Win,
} from './api.ts';
import { askConfirm } from './ask.tsx';
import { copyText } from './selection.ts';
import { errorText } from './errors.ts';
import { noteTitle, type Note } from './notes.ts';
import { SheetBar, useSheet } from './sheet.tsx';
import { KIND_LABEL } from './spaces.ts';
import {
  buildSpaceChiefBrief,
  chiefsInSpace,
  expandSpacePath,
  notesInSpace,
  unmanagedInSpace,
  workersOf,
} from './spacePortal.ts';
import { statusWord } from './status.ts';
import { useNotes } from './useNotes.ts';

export type PortalTab = 'overview' | 'notes' | 'files' | 'tasks' | 'memory';

const toast = (text: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: text }));
const ago = (t: number) => (age(t) === 'now' ? 'just now' : `${age(t)} ago`);

const TASK_STATUSES: Array<{ id: FleetTaskStatus; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'in_review', label: 'In review' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
];

const PRIORITIES: Array<{ value: number; label: string }> = [
  { value: 0, label: 'P0 Urgent' },
  { value: 1, label: 'P1 High' },
  { value: 2, label: 'P2 Normal' },
  { value: 3, label: 'P3 Low' },
];

function shortHome(p: string, home: string): string {
  const clean = home.replace(/\/+$/, '');
  if (clean && (p === clean || p.startsWith(`${clean}/`))) return `~${p.slice(clean.length)}`;
  return p;
}

type Props = {
  space: SpaceView | null;
  spaceName: string;
  host: string;
  home: string;
  /** Live sessions belonging to this Space. */
  windows: Win[];
  /** All live sessions on this host (for resolving workers & cross-space chiefs). */
  allWindows: Win[];
  /** Merged state (all hosts, for cross-host navigation & notes). */
  state: State;
  /** The selected Space's own host state (its features, presets, home, defaultSession, fleet revision). */
  hostState?: State;
  client: HostApi;
  narrow: boolean;
  onOpen: (w: Win) => void;
  onOpenKey: (key: string) => void;
  onNewSession: () => void;
  onSpaceSettings?: () => void;
  refresh: (host?: string) => Promise<State | null>;
  /** Overview session cards & rows rendered by Inbox. */
  children: React.ReactNode;
};

/**
 * Space Portal: transforms selecting a Space into entering its own workspace world—
 * with its Chief(s) of Staff, Space-scoped Notes, Space Files & Artifacts, Space Tasks,
 * and (for plain Spaces) Preferences & Memory.
 */
export function SpacePortal({
  space,
  spaceName,
  host,
  home,
  windows,
  allWindows,
  state,
  hostState,
  client,
  narrow,
  onOpen,
  onOpenKey,
  onNewSession,
  onSpaceSettings,
  refresh,
  children,
}: Props) {
  const effectiveHostState = hostState ?? state;
  const [tab, setTab] = useState<PortalTab>('overview');
  const [chiefModal, setChiefModal] = useState(false);
  const [contextModal, setContextModal] = useState(false);
  const [tasks, setTasks] = useState<FleetTask[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [selectedChiefUid, setSelectedChiefUid] = useState<string | null>(null);

  // Reset to Overview and clear stale Space task state when switching Spaces.
  useEffect(() => {
    setTab('overview');
    setTasks([]);
    setTasksLoaded(false);
    setTaskError(null);
    setSelectedChiefUid(null);
  }, [host, spaceName]);

  const absPath = expandSpacePath(space?.path ?? windows[0]?.projectPath ?? null, home);
  const contextAbsPath = expandSpacePath(space?.contextPath ?? space?.path ?? windows[0]?.projectPath ?? null, home);
  const plain = space?.kind === 'space';
  const chiefs = chiefsInSpace(allWindows, spaceName, host);
  const activeChief = chiefs.find((c) => c.uid === selectedChiefUid) ?? chiefs[0] ?? null;
  const unmanaged = unmanagedInSpace(windows, spaceName, host);
  const supportsFleet = (effectiveHostState.features?.fleet ?? 0) > 0;
  const supportsSupervision = (effectiveHostState.features?.supervision ?? 0) > 0;
  const supportsSpaceContext = plain || (effectiveHostState.features?.spaces ?? 0) >= 2;
  const fleetRevision = effectiveHostState.fleet?.revision ?? 0;

  const book = useNotes();
  const spaceNotes = notesInSpace(book.list(), host, absPath, home);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const taskReqId = useRef(0);

  const loadTasks = useCallback(() => {
    if (!supportsFleet) return;
    const reqId = ++taskReqId.current;
    client
      .fleetTasks({ space: spaceName })
      .then((r) => {
        if (taskReqId.current !== reqId) return;
        setTasks(r.tasks);
        setTasksLoaded(true);
        setTaskError(null);
      })
      .catch((err) => {
        if (taskReqId.current !== reqId) return;
        setTaskError(errorText(err));
        setTasksLoaded(true);
      });
  }, [client, spaceName, supportsFleet]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks, tab, fleetRevision]);

  const createSpaceNote = () => {
    if (!absPath) return toast('This Space has no folder on disk yet.');
    const n = book.create({ project: { host, path: absPath } });
    setOpenNoteId(n.id);
    setTab('notes');
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.space-note-textarea')?.focus());
  };

  async function adoptAll(chief: Win) {
    let ok = 0;
    const failed: string[] = [];
    for (const w of unmanaged) {
      try {
        await client.setSupervision(w.uid, { role: 'worker', managedBy: chief.uid, muteAlerts: true });
        ok++;
      } catch (e) {
        failed.push(`${w.title}: ${errorText(e)}`);
      }
    }
    await refresh(host);
    if (failed.length) {
      toast(`Adopted ${ok} of ${unmanaged.length}; failed: ${failed[0]}`);
    } else if (ok > 0) {
      toast(`Assigned ${ok} session${ok === 1 ? '' : 's'} to ${chief.title}`);
    }
  }

  const openTaskCount = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length;
  const filesRoot = absPath ?? contextAbsPath;
  const tabs: Array<{ id: PortalTab; label: string; count?: number }> = [
    { id: 'overview', label: 'Sessions', count: windows.length },
    ...(absPath ? [{ id: 'notes' as const, label: 'Notes', count: spaceNotes.length }] : []),
    ...(filesRoot ? [{ id: 'files' as const, label: 'Files' }] : []),
    ...(supportsFleet ? [{ id: 'tasks' as const, label: 'Tasks', count: openTaskCount }] : []),
    ...(supportsSpaceContext ? [{ id: 'memory' as const, label: 'Knowledge' }] : []),
  ];

  const displayPath = space?.path ? canonicalProjectPath(space.path) : null;
  const extraRoots = [...new Set((space?.roots ?? []).map(canonicalProjectPath))].filter((r) => r !== displayPath);

  return (
    <div className="space-portal">
      <div className="space-portal-bar">
        <div className="space-portal-meta">
          <span className="space-kind-pill">{space ? KIND_LABEL[space.kind] : 'Space'}</span>
          {displayPath && <code className="space-portal-path">{displayPath}</code>}
          {extraRoots.map((r) => (
            <code key={r} className="space-root-chip" title={`Attached root: ${r}`}>
              +{r.split('/').pop() || r}
            </code>
          ))}
          {chiefs.length > 0 && (
            <span className="space-chief-count">
              {chiefs.length === 1 ? '1 Chief' : `${chiefs.length} Chiefs`}
            </span>
          )}
        </div>
        <div className="space-portal-actions">
          {supportsSupervision && (
            <button className="btn small" onClick={() => setChiefModal(true)}>
              {chiefs.length ? '+ Chief' : 'Start Chief'}
            </button>
          )}
          {supportsSpaceContext && (
            <button className="btn ghost small" onClick={() => setContextModal(true)} title="Inspect the live Space context bundle injected into harnesses">
              Context
            </button>
          )}
          {!narrow && absPath && (
            <button className="btn ghost small" onClick={createSpaceNote}>
              New note
            </button>
          )}
          {!narrow && onSpaceSettings && (
            <button className="icon-btn small" onClick={onSpaceSettings} title="Space settings" aria-label="Space settings">
              <Icon name="gear" size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="seg space-portal-tabs" role="tablist" aria-label={`${spaceName} portal`}>
        <Glide match=".on" className="thumb" />
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            <span>{t.label}</span>
            {t.count !== undefined && t.count > 0 && <span className="tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          {supportsSupervision && (
            <section className="space-chief-strip" aria-label="Chief of Staff">
              {chiefs.length === 0 ? (
                <div className="space-chief-empty">
                  <div className="grow">
                    <p className="space-chief-title">No Chief of Staff in {spaceName} yet</p>
                    <p className="hint">
                      Start one to coordinate sessions in this Space, read its notes and artifacts, and escalate only what needs you. Control flows strictly downward.
                    </p>
                  </div>
                  <button className="btn primary small" onClick={() => setChiefModal(true)}>
                    Start Chief of Staff
                  </button>
                </div>
              ) : (
                <div className="space-chief-grid">
                  {chiefs.map((c) => (
                    <SpaceChiefCard
                      key={c.key}
                      chief={c}
                      workers={workersOf(allWindows, c.uid, host)}
                      unmanagedCount={unmanaged.length}
                      client={client}
                      onOpen={onOpen}
                      onAdoptAll={() => void adoptAll(c)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
          {children}
        </>
      )}

      {tab === 'notes' && absPath && (
        <SpaceNotesPane
          spaceName={spaceName}
          host={host}
          absPath={absPath}
          displayPath={shortHome(absPath, home)}
          notes={spaceNotes}
          openId={openNoteId}
          setOpenId={setOpenNoteId}
          onCreate={createSpaceNote}
          state={state}
          client={client}
          narrow={narrow}
          chiefs={chiefs}
          selectedChief={activeChief}
          onSelectChief={setSelectedChiefUid}
          canPromote={supportsSpaceContext}
          onOpenKey={onOpenKey}
        />
      )}

      {tab === 'files' && filesRoot && (
        <SpaceFilesPane
          spaceName={spaceName}
          absPath={filesRoot}
          contextAbsPath={contextAbsPath ?? filesRoot}
          hasSpaceContext={supportsSpaceContext}
          client={client}
          chiefs={chiefs}
          chief={activeChief}
          onSelectChief={setSelectedChiefUid}
          onOpenChief={activeChief ? () => onOpen(activeChief) : undefined}
        />
      )}

      {tab === 'tasks' && supportsFleet && (
        <SpaceTasksPane
          spaceName={spaceName}
          tasks={tasks}
          loaded={tasksLoaded}
          error={taskError}
          sessions={windows}
          client={client}
          onChanged={loadTasks}
          onOpen={onOpen}
        />
      )}

      {tab === 'memory' && supportsSpaceContext && (
        <SpaceMemoryPane
          spaceName={spaceName}
          isPlain={plain}
          contextPath={space?.contextPath}
          client={client}
        />
      )}

      {chiefModal && (
        <StartChiefDialog
          spaceName={spaceName}
          spacePath={absPath}
          spaceKind={space?.kind ?? 'space'}
          host={host}
          state={effectiveHostState}
          client={client}
          existingSessions={windows}
          unmanaged={unmanaged}
          onClose={() => setChiefModal(false)}
          onStarted={async (id, uid) => {
            setChiefModal(false);
            await waitForWindow(() => refresh(host), { id, uid });
            onOpenKey(host === state.hostname ? uid : `${host}/${uid}`);
          }}
        />
      )}

      {contextModal && (
        <SpaceContextDialog spaceName={spaceName} client={client} onClose={() => setContextModal(false)} />
      )}
    </div>
  );
}

/** Chief of Staff command card: live status, clickable worker roster, one-tap Adopt, and quick directive input. */
function SpaceChiefCard({
  chief,
  workers,
  unmanagedCount,
  client,
  onOpen,
  onAdoptAll,
}: {
  chief: Win;
  workers: Win[];
  unmanagedCount: number;
  client: HostApi;
  onOpen: (w: Win) => void;
  onAdoptAll: () => void;
}) {
  const { color } = look(chief.agent);
  const [quickText, setQuickText] = useState('');
  const [sending, setSending] = useState(false);
  const [wakes, setWakes] = useState<Job[]>([]);
  const [togglingWake, setTogglingWake] = useState<string | null>(null);

  const loadWakes = useCallback(() => {
    const owner = `system:chief:${chief.uid}`;
    client
      .jobs()
      .then((res) =>
        setWakes(
          (res.jobs ?? []).filter(
            (j) => (j.createdBy === owner || (j.action.kind === 'send' && j.action.target === chief.uid)) && j.state !== 'cancelled' && j.state !== 'done',
          ),
        ),
      )
      .catch(() => {});
  }, [client, chief.uid]);

  useEffect(() => {
    loadWakes();
  }, [loadWakes]);

  async function toggleWake(j: Job) {
    setTogglingWake(j.id);
    try {
      await client.jobVerb(j.id, j.state === 'paused' ? 'resume' : 'pause');
      loadWakes();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setTogglingWake(null);
    }
  }

  async function sendQuick(e: React.FormEvent) {
    e.preventDefault();
    const msg = quickText.trim();
    if (!msg || sending) return;
    setSending(true);
    try {
      await client.send(chief.uid, msg, true);
      setQuickText('');
      toast(`Sent to ${chief.title || chief.name}`);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-chief-card">
      <div className="space-chief-top">
        <button className="space-chief-main" onClick={() => onOpen(chief)}>
          <span className="chip sm" style={{ '--agent': color } as React.CSSProperties}>
            <AgentLogo id={chief.agent} size={14} />
          </span>
          <span className={`dot ${chief.status}`} />
          <span className="space-chief-info">
            <span className="space-chief-name-row">
              <span className="name">{chief.title || chief.name}</span>
              <span className="chief-badge">Chief</span>
            </span>
            <span className="sub">
              {statusWord(chief)} · {workers.length === 1 ? '1 worker' : `${workers.length} workers`}
              {chief.supervision?.space ? ` · Scoped to ${chief.supervision.space}` : ' · Fleet-wide'}
            </span>
          </span>
        </button>
        {unmanagedCount > 0 && (
          <button className="btn ghost small" onClick={onAdoptAll} title="Assign unmanaged sessions in this Space to this Chief">
            Adopt {unmanagedCount}
          </button>
        )}
      </div>
      {workers.length > 0 && (
        <div className="space-chief-workers" aria-label="Supervised workers">
          {workers.map((w) => (
            <button key={w.key} type="button" className="worker-chip" onClick={() => onOpen(w)} title={`Open worker ${w.title || w.name}`}>
              <span className={`dot ${w.status}`} />
              <span>{w.title || w.name}</span>
              {w.space && w.space !== w.project && <span className="worker-chip-repo">{w.project}</span>}
            </button>
          ))}
        </div>
      )}
      {wakes.length > 0 && (
        <div className="space-chief-wakes" aria-label="Event wakes">
          {wakes.map((j) => {
            const paused = j.state === 'paused';
            const label = j.trigger.kind === 'session' ? `on ${j.trigger.on}` : j.name;
            return (
              <button
                key={j.id}
                type="button"
                className={`wake-pill ${paused ? 'paused' : ''}`}
                disabled={togglingWake === j.id}
                onClick={() => void toggleWake(j)}
                title={`${j.name} (${j.state}) — click to ${paused ? 'resume' : 'pause'}`}
              >
                <span className={`dot ${paused ? 'idle' : 'busy'}`} />
                <span>{paused ? `Paused · ${label}` : `Wake · ${label}`}</span>
              </button>
            );
          })}
        </div>
      )}
      <form className="space-chief-quick" onSubmit={(e) => void sendQuick(e)}>
        <input
          value={quickText}
          onChange={(e) => setQuickText(e.target.value)}
          placeholder={`Direct ${chief.title || 'Chief'}…`}
          aria-label={`Quick message to ${chief.title || 'Chief'}`}
          disabled={sending}
        />
        <button type="submit" className="btn ghost small" disabled={sending || !quickText.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

/** Space-scoped Notes workspace: notes created here belong to this Space automatically. */
function SpaceNotesPane({
  spaceName,
  host,
  absPath,
  displayPath,
  notes,
  openId,
  setOpenId,
  onCreate,
  state,
  client,
  narrow,
  chiefs,
  selectedChief,
  onSelectChief,
  canPromote,
  onOpenKey,
}: {
  spaceName: string;
  host: string;
  absPath: string;
  displayPath: string;
  notes: Note[];
  openId: string | null;
  setOpenId: (id: string | null) => void;
  onCreate: () => void;
  state: State;
  client: HostApi;
  narrow: boolean;
  chiefs: Win[];
  selectedChief: Win | null;
  onSelectChief: (uid: string) => void;
  canPromote: boolean;
  onOpenKey: (key: string) => void;
}) {
  const book = useNotes();
  const [preview, setPreview] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const selected = (openId ? notes.find((n) => n.id === openId) : null) ?? (!narrow ? notes[0] ?? null : null);

  async function promote(note: Note) {
    setPromoting(true);
    try {
      const res = await client.promoteSpaceKnowledge(spaceName, {
        title: noteTitle(note),
        markdown: note.markdown,
        source: `note:${note.id}`,
      });
      toast(`Promoted to Space memory (${res.file.name})`);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setPromoting(false);
    }
  }

  async function sendToChief(note: Note, chief: Win) {
    try {
      const id = crypto.randomUUID();
      await client.handNote({ id, noteId: note.id, revision: note.revision, target: chief.uid, text: note.markdown });
      book.recordSession(note.id, { uid: chief.uid, host, title: chief.title, via: 'handoff', at: Math.floor(Date.now() / 1000) });
      toast(`Sent "${noteTitle(note)}" to ${chief.title}`);
    } catch (e) {
      toast(errorText(e));
    }
  }

  async function remove(note: Note) {
    if (note.markdown.trim() && !(await askConfirm({ title: `Delete “${noteTitle(note)}”?`, body: 'It goes from every device.', confirm: 'Delete', danger: true }))) return;
    book.remove(note.id);
    if (openId === note.id) setOpenId(null);
  }

  return (
    <div className="space-pane space-notes-pane">
      {(!narrow || !selected) && (
        <div className="space-notes-list">
          <div className="space-pane-head">
            <span className="hint">
              Notes in <strong>{spaceName}</strong> ({notes.length})
            </span>
            <button className="btn primary small" onClick={onCreate}>
              New note
            </button>
          </div>
          {notes.length === 0 ? (
            <div className="empty-state compact">
              <p className="empty-title">No notes in {spaceName} yet.</p>
              <p className="hint">Create specs, briefs, or scratchpads scoped to this Space and hand them straight to its Chief of Staff or any session.</p>
              <button className="btn primary small" onClick={onCreate}>
                New note in {spaceName}
              </button>
            </div>
          ) : (
            <ul className="rows">
              {notes.map((n) => (
                <li key={n.id}>
                  <button className={`row note-row ${selected?.id === n.id ? 'on' : ''}`} onClick={() => setOpenId(n.id)}>
                    <Icon name="note" size={16} />
                    <span className="stack grow">
                      <span className="name">{noteTitle(n)}</span>
                      <span className="sub">{ago(n.updatedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {selected && (
        <div className="space-note-editor">
          <div className="space-note-head">
            {narrow && (
              <button className="icon-btn small" onClick={() => setOpenId(null)} aria-label="Back to notes">
                <Icon name="back" size={16} />
              </button>
            )}
            <input
              className="note-title"
              value={selected.title}
              placeholder={noteTitle({ title: '', markdown: selected.markdown })}
              aria-label="Note title"
              maxLength={200}
              onChange={(e) => book.edit(selected.id, { title: e.target.value })}
            />
            <div className="seg" role="radiogroup" aria-label="Show">
              <button role="radio" aria-checked={!preview} className={preview ? '' : 'on'} onClick={() => setPreview(false)}>
                Edit
              </button>
              <button role="radio" aria-checked={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
                Preview
              </button>
            </div>
          </div>
          <div className="space-note-actions">
            {selectedChief && selected.markdown.trim() && (
              <>
                {chiefs.length > 1 && (
                  <select
                    className="space-select"
                    aria-label="Target Chief of Staff"
                    value={selectedChief.uid}
                    onChange={(e) => onSelectChief(e.target.value)}
                  >
                    {chiefs.map((c) => (
                      <option key={c.uid} value={c.uid}>
                        {c.title || c.name}
                      </option>
                    ))}
                  </select>
                )}
                <button className="btn small" onClick={() => void sendToChief(selected, selectedChief)}>
                  Send to {chiefs.length > 1 ? selectedChief.title || 'Chief' : 'Chief'}
                </button>
              </>
            )}
            {canPromote && selected.markdown.trim() && (
              <button className="btn ghost small" disabled={promoting} onClick={() => void promote(selected)} title="Promote this note into Space shared memory & index">
                {promoting ? 'Promoting…' : 'Promote to Knowledge'}
              </button>
            )}
            <button className="btn ghost small" disabled={!selected.markdown.trim()} onClick={() => setHandoff(true)}>
              Send to…
            </button>
            <button className="btn ghost small danger space-note-delete" onClick={() => void remove(selected)}>
              Delete
            </button>
          </div>
          {preview ? (
            <div className="space-note-preview md">
              <Markdown text={selected.markdown || '*Empty note*'} />
            </div>
          ) : (
            <textarea
              className="space-note-textarea"
              value={selected.markdown}
              placeholder={`Write Markdown for ${spaceName}…`}
              aria-label="Note markdown"
              onChange={(e) => book.edit(selected.id, { markdown: e.target.value })}
            />
          )}
          <div className="space-note-foot hint">
            Filed in <code>{displayPath}</code> · Updated {ago(selected.updatedAt)}
          </div>
          {handoff && (
            <HandToSession
              note={selected}
              state={state}
              client={client}
              mode="send"
              onClose={() => setHandoff(false)}
              onOpenSession={(k) => {
                setHandoff(false);
                onOpenKey(k);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Space-scoped Files & Artifacts browser rooted in the Space folder. */
function SpaceFilesPane({
  spaceName,
  absPath,
  contextAbsPath,
  hasSpaceContext,
  client,
  chiefs,
  chief,
  onSelectChief,
  onOpenChief,
}: {
  spaceName: string;
  absPath: string;
  contextAbsPath: string;
  hasSpaceContext: boolean;
  client: HostApi;
  chiefs: Win[];
  chief: Win | null;
  onSelectChief: (uid: string) => void;
  onOpenChief?: () => void;
}) {
  const [rootPath, setRootPath] = useState(absPath);
  const [keyBump, setKeyBump] = useState(0);

  useEffect(() => {
    setRootPath(absPath);
  }, [absPath]);

  async function jump(sub?: 'artifacts' | 'memory') {
    if (!sub) {
      setRootPath(absPath);
      setKeyBump((k) => k + 1);
      return;
    }
    // Use Space-owned context directory for artifacts/ & memory/ so repo Spaces never pollute git working trees.
    const base = contextAbsPath || absPath;
    const target = `${base}/${sub}`;
    await client.fs.mkdir(target).catch(() => {});
    setRootPath(target);
    setKeyBump((k) => k + 1);
  }

  async function handleInsert(ref: string) {
    const clean = ref.trim();
    if (chief) {
      try {
        await client.send(chief.uid, `Please review ${clean}`, true);
        toast(`Sent ${clean} to ${chief.title}`);
        onOpenChief?.();
        return;
      } catch (e) {
        toast(errorText(e));
        return;
      }
    }
    await copyText(clean).catch(() => {});
    toast(`Copied ${clean}`);
  }

  return (
    <div className="space-pane space-files-pane">
      <div className="space-pane-head">
        <div className="space-quick-dirs">
          <button className={`btn ghost small ${rootPath === absPath ? 'on' : ''}`} onClick={() => void jump()}>
            {spaceName}/
          </button>
          <button className={`btn ghost small ${rootPath === `${contextAbsPath}/artifacts` ? 'on' : ''}`} onClick={() => void jump('artifacts')}>
            artifacts/
          </button>
          {hasSpaceContext && (
            <button className={`btn ghost small ${rootPath === `${contextAbsPath}/memory` ? 'on' : ''}`} onClick={() => void jump('memory')}>
              memory/
            </button>
          )}
        </div>
        <div className="space-files-target">
          {chiefs.length > 1 && chief && (
            <select
              className="space-select"
              aria-label="Chief target for file inserts"
              value={chief.uid}
              onChange={(e) => onSelectChief(e.target.value)}
            >
              {chiefs.map((c) => (
                <option key={c.uid} value={c.uid}>
                  {c.title || c.name}
                </option>
              ))}
            </select>
          )}
          <span className="hint">{chief ? `Insert sends to ${chief.title}` : 'Drop files below to upload into this Space'}</span>
        </div>
      </div>
      <FilesPanel
        key={`${rootPath}:${keyBump}`}
        fs={client.fs}
        start={rootPath}
        cwd={absPath}
        agent={chief?.agent ?? 'claude'}
        onInsert={(t) => void handleInsert(t)}
      />
    </div>
  );
}

/** Space-scoped fleet task ledger. */
function SpaceTasksPane({
  spaceName,
  tasks,
  loaded,
  error,
  sessions,
  client,
  onChanged,
  onOpen,
}: {
  spaceName: string;
  tasks: FleetTask[];
  loaded: boolean;
  error?: string | null;
  sessions: Win[];
  client: HostApi;
  onChanged: () => void;
  onOpen: (w: Win) => void;
}) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState(2);
  const [assignedUid, setAssignedUid] = useState('');
  const [busy, setBusy] = useState(false);

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await client.createFleetTask({
        title: title.trim(),
        space: spaceName,
        priority,
        ...(assignedUid ? { assignedUid } : {}),
      });
      setTitle('');
      onChanged();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(t: FleetTask, status: FleetTaskStatus) {
    try {
      await client.updateFleetTask(t.id, { status });
      onChanged();
    } catch (err) {
      toast(errorText(err));
    }
  }

  async function remove(t: FleetTask) {
    try {
      await client.deleteFleetTask(t.id);
      onChanged();
    } catch (err) {
      toast(errorText(err));
    }
  }

  return (
    <div className="space-pane space-tasks-pane">
      {error && <p className="err">{error}</p>}
      <form className="space-task-form" onSubmit={(e) => void addTask(e)}>
        <input
          className="space-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`Add a task for ${spaceName}…`}
          aria-label="New task title"
          maxLength={200}
        />
        <select
          className="space-select"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
          aria-label="Task priority"
        >
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {sessions.length > 0 && (
          <select className="space-select" value={assignedUid} onChange={(e) => setAssignedUid(e.target.value)} aria-label="Assign to session">
            <option value="">Unassigned</option>
            {sessions.map((w) => (
              <option key={w.uid} value={w.uid}>
                {w.title || w.name}
              </option>
            ))}
          </select>
        )}
        <button type="submit" className="btn primary small" disabled={busy || !title.trim()}>
          Add task
        </button>
      </form>

      {!loaded ? (
        <p className="hint">Loading tasks…</p>
      ) : tasks.length === 0 ? (
        <div className="empty-state compact">
          <p className="empty-title">No tasks in {spaceName} yet.</p>
          <p className="hint">Tasks persist across restarts and are visible to this Space's Chief of Staff via `ah tasks --space "{spaceName}"`.</p>
        </div>
      ) : (
        <ul className="rows space-task-list">
          {tasks.map((t) => {
            const assignee = t.assignedUid ? sessions.find((w) => w.uid === t.assignedUid) : null;
            const done = t.status === 'done' || t.status === 'cancelled';
            return (
              <li key={t.id} className={`space-task-row${done ? ' is-done' : ''}`}>
                <span className={`space-prio p${t.priority}`}>P{t.priority}</span>
                <span className="space-task-info">
                  <span className="name">{t.title}</span>
                  {t.description && <span className="space-task-desc">{t.description}</span>}
                  <span className="sub">
                    <span className="mono">{t.id}</span>
                    {assignee ? (
                      <>
                        {' · '}
                        <button type="button" className="linkish" onClick={() => onOpen(assignee)}>
                          {assignee.title || assignee.name}
                        </button>
                      </>
                    ) : t.assignedUid ? (
                      ` · ${t.assignedUid}`
                    ) : (
                      ' · Unassigned'
                    )}
                    {t.lastVerify && ` · Verify ${t.lastVerify.ok ? '✓' : `✗ (${t.lastVerify.exitCode})`}`}
                    {t.result && ` · ${t.result}`}
                  </span>
                </span>
                <div className="space-task-controls">
                  <select
                    className="space-select task-status-select"
                    value={t.status}
                    aria-label={`Status for ${t.title}`}
                    onChange={(e) => void setStatus(t, e.target.value as FleetTaskStatus)}
                  >
                    {TASK_STATUSES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="icon-btn small" aria-label={`Delete ${t.title}`} onClick={() => void remove(t)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Inline editable memory file inside SpaceMemoryPane. */
function SpaceMemoryEntry({
  file,
  onSave,
  onDelete,
}: {
  file: MemoryFile;
  onSave: (text: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [text, setText] = useState(file.text);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(file.text), [file.text]);
  const dirty = text !== file.text;

  return (
    <details className="space-memory">
      <summary>
        <span className="mono">{file.name}</span>
        <span className="sub">{file.text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? 'Empty'}</span>
      </summary>
      <div className="space-memory-body">
        <div className="space-memory-bar">
          <div className="seg" role="radiogroup" aria-label={`${file.name} mode`}>
            <button type="button" role="radio" aria-checked={!editing} className={!editing ? 'on' : ''} onClick={() => setEditing(false)}>
              Preview
            </button>
            <button type="button" role="radio" aria-checked={editing} className={editing ? 'on' : ''} onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
          <div className="space-memory-bar-actions">
            {onDelete && (
              <button
                type="button"
                className="btn ghost small danger"
                disabled={busy}
                onClick={async () => {
                  if (!(await askConfirm({ title: `Delete ${file.name}?`, body: 'Agents in this Space stop reading it. It can’t be undone.', confirm: 'Delete', danger: true }))) return;
                  setBusy(true);
                  await onDelete().finally(() => setBusy(false));
                }}
              >
                Delete
              </button>
            )}
            {editing && (
              <button
                type="button"
                className="btn primary small"
                disabled={!dirty || busy}
                onClick={() => void (setBusy(true), onSave(text).finally(() => setBusy(false)))}
              >
                Save
              </button>
            )}
          </div>
        </div>
        {file.truncated && <p className="hint">Only the first 256 KB is shown; saving keeps only what's here.</p>}
        {editing ? (
          <textarea className="space-note-textarea" value={text} onChange={(e) => setText(e.target.value)} aria-label={file.name} />
        ) : (
          <div className="space-note-preview md">
            <Markdown text={file.text || '*Empty*'} />
          </div>
        )}
      </div>
    </details>
  );
}

/** Inline Preferences (`AGENTS.md`) and editable Memory (`memory/*.md`) for every Space kind. */
function SpaceMemoryPane({
  spaceName,
  isPlain,
  contextPath,
  client,
}: {
  spaceName: string;
  isPlain: boolean;
  contextPath?: string | null;
  client: HostApi;
}) {
  const [prefs, setPrefs] = useState<{ text: string; saved: string; updatedAt: number } | null>(null);
  const [memory, setMemory] = useState<MemoryFile[] | null>(null);
  const [newFile, setNewFile] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadMemory = useCallback(() => {
    client
      .spaceMemory(spaceName)
      .then((m) => setMemory(m.files))
      .catch((e) => setError(errorText(e)));
  }, [client, spaceName]);

  useEffect(() => {
    setError(null);
    client
      .spacePreferences(spaceName)
      .then((p) => setPrefs({ text: p.text, saved: p.text, updatedAt: p.updatedAt }))
      .catch((e) => setError(errorText(e)));
    loadMemory();
  }, [client, spaceName, loadMemory]);

  async function savePrefs() {
    if (!prefs) return;
    setSaving(true);
    try {
      const p = await client.putSpacePreferences(spaceName, prefs.text, prefs.updatedAt || undefined);
      setPrefs({ text: p.text, saved: p.text, updatedAt: p.updatedAt });
      toast('Saved Space preferences');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const cleanNew = newFile.trim().replace(/\.md$/i, '');

  return (
    <div className="space-pane space-memory-pane">
      {error && <p className="form-error">{error}</p>}
      <section className="space-section">
        <h3>Preferences (AGENTS.md)</h3>
        <p className="hint">
          {isPlain
            ? `Shared instructions read by every agent and Chief of Staff started in ${spaceName}.`
            : `Space-owned instructions for ${spaceName}${contextPath ? ` (${contextPath})` : ''} — kept outside your git repository.`}
        </p>
        {prefs ? (
          <>
            <div className="field">
              <textarea className="mono" rows={9} value={prefs.text} onChange={(e) => setPrefs({ ...prefs, text: e.target.value })} aria-label="Space preferences" />
            </div>
            <div className="actions">
              <button className="btn primary small" disabled={saving || prefs.text === prefs.saved} onClick={() => void savePrefs()}>
                Save preferences
              </button>
            </div>
          </>
        ) : (
          <p className="hint">Loading…</p>
        )}
      </section>
      <section className="space-section">
        <h3>Shared Knowledge &amp; Memory (memory/)</h3>
        {memory === null ? (
          <p className="hint">Loading…</p>
        ) : memory.length === 0 ? (
          <p className="hint">No memory files yet.</p>
        ) : (
          memory.map((f) => (
            <SpaceMemoryEntry
              key={f.name}
              file={f}
              onSave={async (text) => {
                setError(null);
                try {
                  const got = await client.putSpaceMemory(spaceName, f.name, text, f.updatedAt || undefined);
                  setMemory((m) => m && m.map((x) => (x.name === f.name ? got : x)));
                  toast(`Saved ${f.name}`);
                } catch (e) {
                  setError(errorText(e));
                }
              }}
              onDelete={
                f.name === 'MEMORY.md'
                  ? undefined
                  : async () => {
                      setError(null);
                      try {
                        await client.deleteSpaceMemory(spaceName, f.name);
                        loadMemory();
                        toast(`Deleted ${f.name}`);
                      } catch (e) {
                        setError(errorText(e));
                      }
                    }
              }
            />
          ))
        )}
        <form
          className="space-new-memory-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!cleanNew) return;
            if (cleanNew.toUpperCase() === 'MEMORY') {
              setError('MEMORY.md is the memory index: edit it above instead of creating a new file named MEMORY.');
              return;
            }
            setError(null);
            try {
              await client.putSpaceMemory(spaceName, `${cleanNew}.md`, `# ${cleanNew}\n`);
              setNewFile('');
              loadMemory();
              toast(`Added ${cleanNew}.md`);
            } catch (err) {
              setError(errorText(err));
            }
          }}
        >
          <input
            className="space-input"
            value={newFile}
            onChange={(e) => setNewFile(e.target.value)}
            placeholder="Add knowledge file, e.g. decisions"
            aria-label="New memory file"
            maxLength={77}
            autoCapitalize="off"
            spellCheck={false}
          />
          <button type="submit" className="btn small" disabled={!cleanNew}>
            Add file
          </button>
        </form>
      </section>
    </div>
  );
}

/** Modal to start a Chief of Staff inside a Space (defaults to Space-scoped, allows multiple). */
function StartChiefDialog({
  spaceName,
  spacePath,
  spaceKind,
  host,
  state,
  client,
  existingSessions,
  unmanaged,
  onClose,
  onStarted,
}: {
  spaceName: string;
  spacePath: string | null;
  spaceKind: SpaceView['kind'];
  host: string;
  /** Merged state (all hosts, for cross-host navigation & notes). */
  state: State;
  /** The selected Space's own host state (its features, presets, home, defaultSession, fleet revision). */
  hostState?: State;
  client: HostApi;
  existingSessions: Win[];
  unmanaged: Win[];
  onClose: () => void;
  onStarted: (id: string, uid: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const presets = state.presets.filter((p) => p.available && !p.hidden && p.command);
  const front = frontAgents(presets, state.windows.map((w) => w.agent), {}, 3);
  const [presetId, setPresetId] = useState(() => front[0]?.id ?? presets[0]?.id ?? '');
  const [label, setLabel] = useState(`Chief of Staff · ${spaceName}`);
  const [adopt, setAdopt] = useState(unmanaged.length > 0);
  const [scoped, setScoped] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => dialog.current?.showModal(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!presetId) return;
    setBusy(true);
    setError(null);
    try {
      const cwd = spacePath ?? state.home;
      const created = await client.create({
        preset: presetId,
        cwd,
        session: state.defaultSession,
        label: label.trim() || `Chief of Staff · ${spaceName}`,
        resume: false,
        worktree: false,
        space: spaceName,
        supervision: {
          role: 'chief',
          ...(scoped ? { space: spaceName } : {}),
        },
      });
      if (adopt && unmanaged.length > 0) {
        const results = await Promise.allSettled(
          unmanaged.map((w) => client.setSupervision(w.uid, { role: 'worker', managedBy: created.uid, muteAlerts: true })),
        );
        const failed = results.filter((r) => r.status === 'rejected').length;
        if (failed > 0) {
          toast(`Chief started, but ${failed} of ${unmanaged.length} sessions could not be adopted`);
        }
      }
      let brief: string;
      try {
        brief = (await client.spaceBrief(spaceName, instructions.trim() || undefined)).brief;
      } catch {
        brief = buildSpaceChiefBrief({
          spaceName,
          spacePath,
          spaceKind,
          sessions: existingSessions.map((w) => ({ uid: w.uid, title: w.title || w.name, agent: w.agent, status: w.status })),
          customInstructions: instructions,
        });
      }
      await client.send(created.uid, brief, true);
      await onStarted(created.id, created.uid);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog new-session space-dialog" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form onSubmit={(e) => void submit(e)}>
        <header className="ns-head">
          <h2>Start Chief of Staff</h2>
        </header>
        <p className="hint">
          Launches a Chief of Staff agent inside <strong>{spaceName}</strong>
          {spacePath ? (
            <>
              {' '}
              (<code>{spacePath}</code>)
            </>
          ) : null}{' '}
          with access to all sessions, notes, files, and tasks in this Space. Control is strictly unidirectional (Chief &gt; worker).
        </p>

        <label className="field">
          <span>Agent</span>
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)} required>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} required />
        </label>

        <label className="check">
          <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
          <span>Scope authority to {spaceName} (uncheck for a fleet-wide Chief of Staff)</span>
        </label>

        {unmanaged.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
            <span>
              Supervise {unmanaged.length} existing unmanaged session{unmanaged.length === 1 ? '' : 's'} in {spaceName} (mutes routine worker alerts with fail-open escalation)
            </span>
          </label>
        )}

        <label className="field">
          <span>Mission / instructions (optional)</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
            placeholder="e.g., Coordinate the auth refactor workers, verify tests before marking tasks done, and report blockers."
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <ConfirmButton type="submit" className="btn primary" disabled={busy || !presetId}>
            {busy ? 'Starting…' : 'Start Chief of Staff'}
          </ConfirmButton>
        </div>
      </form>
    </dialog>
  );
}

/** Modal displaying the live Space context bundle injected into harnesses (`GET /api/spaces/:name/context`). */
function SpaceContextDialog({ spaceName, client, onClose }: { spaceName: string; client: HostApi; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [ctx, setCtx] = useState<SpaceContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    client
      .spaceContext(spaceName)
      .then((c) => setCtx(c))
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [client, spaceName]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <dialog ref={dialog} className="sheet" onClose={onClose}>
      <SheetBar title={`${spaceName} · Context`} onClose={dismiss} />
      <div className="sheet-body">
        <p className="hint">
          Automatically synced into <code>.ah-space-context.md</code> and injected into every harness launched in {spaceName} (via <code>$AH_SPACE*</code>, CLI flags, <code>SessionStart</code> hook, and <code>ah mcp</code>).
        </p>
        {error && <p className="form-error">{error}</p>}
        {loading && !ctx ? (
          <p className="hint">Loading Space context…</p>
        ) : ctx ? (
          <>
            <div className="space-portal-meta" style={{ marginBottom: 10 }}>
              <span className="space-kind-pill">{ctx.memoryFiles.length} memory</span>
              <span className="space-kind-pill">{ctx.artifacts.length} artifacts</span>
              <span className="space-kind-pill">{ctx.notes.length} notes</span>
              <code className="space-portal-path" title={ctx.contextFile}>{ctx.contextFile}</code>
            </div>
            <pre className="space-context-pre mono">{ctx.markdown}</pre>
          </>
        ) : null}
        <div className="actions">
          <button type="button" className="btn ghost small" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          {ctx && (
            <button
              type="button"
              className="btn ghost small"
              onClick={() => void copyText(ctx.markdown).then((ok) => toast(ok ? 'Copied Space context' : 'Copy failed'))}
            >
              Copy Markdown
            </button>
          )}
          <button type="button" className="btn primary small" onClick={dismiss}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
