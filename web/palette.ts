// The command palette as a tree, like Omarchy's menu: categories you walk into
// and out of with the arrow keys, and a search over everything below where you
// are. The static shape lives here and points at catalog commands
// (shortcuts.ts); live branches (open sessions, the queue, models) come from
// providers that mounted components register, so the tree only offers what can
// run right now. Pure functions; the dialog is CommandPalette in shortcuts.tsx.
import type { IconName } from './icons.tsx';
import { COMMANDS, commandActive, fuzzy, type CommandId, type SearchTerms } from './shortcuts.ts';

export type PaletteNode = {
  /** Unique within its parent; the path of keys identifies a node. */
  key: string;
  label: string;
  icon?: IconName;
  /** One line under the label (a description, a session's project). */
  detail?: string;
  /** Related words. A query that hits only these ranks under one that hits the name. */
  terms?: SearchTerms;
  /** A catalog command: its chord shows on the row, and choosing it runs it. */
  command?: CommandId;
  /** Any other action. Runs after the palette closes. */
  run?: () => void;
  /** A category. */
  children?: PaletteNode[];
};

/** Where a provider's nodes go in the static tree. */
export type ProviderId = 'sessions' | 'queue' | 'models' | 'efforts' | 'tiles' | 'projects' | 'agents';

type Spec = { key: string; label: string; icon: IconName; detail?: string; terms?: SearchTerms; children: Array<Spec | CommandId | { provider: ProviderId }> };

export const TREE: Spec = {
  key: 'root',
  label: 'Commands',
  icon: 'commands',
  children: [
    'new-session',
    'new-project',
    'switcher',
    'scratchpad',
    { key: 'run', label: 'Run in project', icon: 'files', detail: 'Start an agent or a shell in one of your projects', children: [{ provider: 'projects' }] },
    {
      key: 'go',
      label: 'Go to',
      icon: 'search',
      detail: 'Sessions, pages and focus',
      children: [{ provider: 'sessions' }, 'go-inbox', 'go-history', 'go-settings', 'cycle-prev', 'cycle-next', 'focus-sidebar', 'focus-main'],
    },
    {
      key: 'session',
      label: 'Session',
      icon: 'terminal',
      detail: 'The focused session',
      children: [
        { key: 'answer', label: 'Answer', icon: 'reply', detail: 'Reply, approve, deny', children: ['reply', 'approve', 'deny'] },
        {
          key: 'turn',
          label: 'Turn and queue',
          icon: 'queue',
          detail: 'Stop, send queued messages now, cancel them',
          children: ['interrupt', 'send-now', { provider: 'queue' }, 'clear-queue'],
        },
        { key: 'model', label: 'Model and effort', icon: 'model', detail: 'Switch what runs this session', children: [{ provider: 'models' }, { provider: 'efforts' }, 'pick-model', 'pick-effort'] },
        {
          key: 'panels',
          label: 'Panels',
          icon: 'panel-right',
          detail: 'Diff, files, chat, queue, snapshots',
          children: ['panel-diff', 'panel-files', 'panel-chat', 'panel-queue', 'panel-snapshots', 'panel-preview', 'toggle-panel'],
        },
        { key: 'view', label: 'View', icon: 'view', detail: 'GUI or terminal, steps, copy, scroll', children: ['toggle-view', 'toggle-steps', 'browse-messages', 'copy-last', 'jump-latest', 'scrollback', 'toggle-keys'] },
        { key: 'manage', label: 'Manage', icon: 'edit', detail: 'Rename, fork, hand off, pin, stop', children: ['rename', 'fork', 'send-to', 'pin', 'copy-attach', 'session-menu', 'terminate'] },
        { key: 'continue', label: 'Continue in…', icon: 'send', detail: 'This conversation, in another agent', terms: ['handoff', 'switch agent', 'harness'], children: [{ provider: 'agents' }] },
      ],
    },
    {
      key: 'workspace',
      label: 'Workspace',
      icon: 'pane',
      detail: 'Splits, panes and the sidebar',
      children: [
        'pane-mode',
        { key: 'tiles', label: 'Open as a new pane', icon: 'split-right', detail: 'Beside the focused pane, along its longer side', children: ['open-in-pane', { provider: 'tiles' }] },
        { key: 'split', label: 'Split', icon: 'split-right', detail: 'Open, replace, flip, close panes', terms: ['pane'], children: ['split-right', 'split-below', 'replace-pane', 'toggle-split', 'close-pane', 'exit-split'] },
        { key: 'focus', label: 'Focus pane', icon: 'pane-left', children: ['focus-pane-left', 'focus-pane-right', 'focus-pane-up', 'focus-pane-down'] },
        { key: 'move', label: 'Move pane', icon: 'pane-right', children: ['move-pane-left', 'move-pane-right', 'move-pane-up', 'move-pane-down'] },
        {
          key: 'workspaces',
          label: 'Workspaces',
          icon: 'pane',
          detail: 'Hyprland-style 1–9: go to one, or send the focused session there',
          children: [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((d) => [`workspace-${d}`, `to-workspace-${d}`] as CommandId[]),
        },
        { key: 'resize', label: 'Resize', icon: 'split-right', detail: 'Dividers and the side panel, by key', children: ['resize-mode', 'resize-left', 'resize-right', 'resize-up', 'resize-down', 'maximize-pane'] },
        'toggle-sidebar',
      ],
    },
    { key: 'help', label: 'Help', icon: 'keyboard', children: ['show-shortcuts', 'reload-page'] },
  ],
};

// ---------- providers: live branches registered by mounted components

type Provider = () => PaletteNode[] | Promise<PaletteNode[]>;
const providers = new Map<ProviderId, Provider[]>();

/** The newest registration wins (the focused pane registers last). Returns the unregister. */
export function registerProvider(id: ProviderId, fn: Provider): () => void {
  const list = providers.get(id) ?? [];
  list.push(fn);
  providers.set(id, list);
  return () => {
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  };
}

async function provide(id: ProviderId): Promise<PaletteNode[]> {
  const fn = providers.get(id)?.at(-1);
  if (!fn) return [];
  try {
    return await fn();
  } catch {
    return [];
  }
}

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/**
 * The tree as it stands now: commands that can't run are dropped, live branches
 * filled in, and categories left empty pruned. `active` and `provide` are
 * injectable for tests.
 */
export async function resolveTree(spec: Spec = TREE, opts: { active?: (id: CommandId) => boolean; provide?: (id: ProviderId) => Promise<PaletteNode[]> } = {}): Promise<PaletteNode> {
  const active = opts.active ?? commandActive;
  const fill = opts.provide ?? provide;
  const walk = async (s: Spec): Promise<PaletteNode | null> => {
    const children: PaletteNode[] = [];
    for (const child of s.children) {
      if (typeof child === 'string') {
        const cmd = BY_ID.get(child);
        if (cmd && cmd.id !== 'command-palette' && active(cmd.id)) {
          children.push({ key: cmd.id, label: cmd.label, detail: cmd.detail, command: cmd.id, ...(cmd.terms ? { terms: cmd.terms } : {}) });
        }
      } else if ('provider' in child) {
        children.push(...(await fill(child.provider)));
      } else {
        const sub = await walk(child);
        if (sub) children.push(sub);
      }
    }
    if (!children.length && s.key !== 'root') return null;
    return { key: s.key, label: s.label, icon: s.icon, detail: s.detail, ...(s.terms ? { terms: s.terms } : {}), children };
  };
  return (await walk(spec))!;
}

// ---------- search

export type Hit = {
  node: PaletteNode;
  /** Ancestors below the search scope, outermost first. */
  trail: PaletteNode[];
  score: number;
  /** The query hit a related word only, so this row stays under name matches. */
  related: boolean;
};

/**
 * Everything under `scope` that matches. A name, detail, or breadcrumb match
 * comes first. A related word (`terms`) still finds the item, under those.
 * A label match beats a breadcrumb match, and categories and commands compete
 * on equal terms, so "panels" finds the category and "diff" the command inside it.
 */
export function searchTree(scope: PaletteNode, query: string): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Hit[] = [];
  const visit = (node: PaletteNode, trail: PaletteNode[]) => {
    for (const child of node.children ?? []) {
      const label = fuzzy(q, child.label);
      // The breadcrumb counts only word by word ("panels diff"): as a loose
      // subsequence, any long path would match almost anything.
      const path = [...trail, child].map((n) => n.label.toLowerCase()).join(' ');
      const words = q.split(/\s+/).filter(Boolean);
      const crumbs = words.length > 1 && words.every((w) => path.includes(w)) ? q.length * 2 : 0;
      const detail = child.detail?.toLowerCase().includes(q) ? q.length : 0;
      const own = Math.max(label * 3, crumbs, detail);
      const term = own > 0 ? 0 : (child.terms ?? []).reduce((best, word) => Math.max(best, fuzzy(q, word)), 0);
      const score = own || term;
      if (score > 0) hits.push({ node: child, trail, score: score - trail.length * 0.5, related: own === 0 });
      if (child.children) visit(child, [...trail, child]);
    }
  };
  visit(scope, []);
  // Name matches first. Equal scores keep tree order.
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => Number(a.h.related) - Number(b.h.related) || b.h.score - a.h.score || a.i - b.i)
    .map(({ h }) => h);
}

/** Count of runnable leaves under a category (shown beside it). */
export function leafCount(node: PaletteNode): number {
  return (node.children ?? []).reduce((n, c) => n + (c.children ? leafCount(c) : 1), 0);
}
