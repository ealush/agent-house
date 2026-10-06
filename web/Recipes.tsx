import { useEffect, useState } from 'react';
import { api, type Recipe } from './api.ts';
import { askConfirm } from './ask.tsx';

// Fleet recipes (issue #6): named launch templates for small session teams.
// Stored in the host's config.json beside the presets; editing is JSON with
// server-side validation, so a broken recipe is rejected with the specific
// problem instead of failing mysteriously at launch time.
export function RecipesPanel() {
  const [list, setList] = useState<Recipe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editor, setEditor] = useState<string | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.recipes().then(setList).catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const clean = (recipes: Recipe[]): Recipe[] => recipes.map(({ errors, ...rest }) => rest as Recipe);

  async function saveAll(recipes: Recipe[]) {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveRecipes(clean(recipes));
      setList(saved);
      setEditor(null);
      setImportText(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEditor() {
    if (editor === null || !list) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor);
    } catch (e) {
      setError(`Not valid JSON: ${(e as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('A recipe is a JSON object.');
      return;
    }
    const id = (parsed as { id?: unknown }).id;
    const rest = clean(list).filter((r) => r.id !== (editingId ?? id));
    await saveAll([...rest, parsed as Recipe]);
  }

  async function remove(r: Recipe) {
    if (!list) return;
    if (!(await askConfirm({ title: `Delete recipe "${r.name}"?`, body: 'Runs already launched keep their snapshot and are not affected.', confirm: 'Delete', danger: true }))) return;
    await saveAll(clean(list).filter((x) => x.id !== r.id));
  }

  async function duplicate(r: Recipe) {
    if (!list) return;
    const copy = JSON.parse(JSON.stringify(clean([r])[0])) as Recipe;
    copy.id = `${r.id}-copy`;
    copy.name = `${r.name} copy`;
    await saveAll([...clean(list), copy]);
  }

  async function doImport() {
    if (importText === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch (e) {
      setError(`Not valid JSON: ${(e as Error).message}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      setError('Import expects a JSON list of recipes.');
      return;
    }
    await saveAll(parsed as Recipe[]);
  }

  async function exportAll() {
    if (!list) return;
    const text = JSON.stringify(clean(list), null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setImportText(text);
    }
  }

  const skeleton = {
    id: 'my-recipe',
    name: 'My recipe',
    description: '',
    members: [
      { key: 'builder', preset: 'claude', title: 'Builder', worktree: true, prompt: '{brief}' },
      { key: 'reviewer', preset: 'codex', title: 'Reviewer', cwdFrom: 'builder', prompt: 'Wait for the handoff before reviewing.' },
    ],
    handoffs: [{ when: { session: 'builder', event: 'turn-end' }, sendTo: 'reviewer', template: 'Review the diff in {builder.worktree} on branch {builder.branch}.' }],
  };

  return (
    <div className="sec-card">
      <p className="hint">
        A recipe launches a small team of sessions in one go: each member is a preset with an opening prompt, and handoffs send a message to another member when a
        turn ends or a session needs you. Recipes live in this host's config file; the server validates them and names the exact problem when one is wrong.
      </p>
      {error && <p className="form-error">{error}</p>}
      {!list && !error && <p className="hint">Loading…</p>}
      {list && (
        <ul className="worktrees">
          {list.map((r) => (
            <li key={r.id}>
              <div className="stack">
                <span>
                  {r.name} <span className="hint">· {r.id}</span>
                </span>
                <span className="sub">
                  {r.members.map((m) => `${m.title ?? m.key} (${m.preset})`).join(' · ')}
                  {r.handoffs?.length ? ` · ${r.handoffs.length} handoff${r.handoffs.length === 1 ? '' : 's'}` : ''}
                </span>
                {r.errors?.length ? <span className="form-error">{r.errors.join('; ')}</span> : null}
              </div>
              <button className="btn small" disabled={busy} onClick={() => { setEditingId(r.id); setEditor(JSON.stringify(clean([r])[0], null, 2)); }}>
                Edit
              </button>
              <button className="btn small" disabled={busy} onClick={() => duplicate(r)}>
                Duplicate
              </button>
              <button className="btn small" disabled={busy} onClick={() => remove(r)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {editor !== null ? (
        <div className="recipe-editor">
          <textarea value={editor} onChange={(e) => setEditor(e.target.value)} rows={18} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          <div className="actions">
            <button className="btn ghost" disabled={busy} onClick={() => setEditor(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy} onClick={saveEditor}>
              Save recipe
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button className="btn" disabled={busy || !list} onClick={() => { setEditingId(null); setEditor(JSON.stringify(skeleton, null, 2)); }}>
            New recipe
          </button>
          <button className="btn ghost" disabled={busy || !list} onClick={exportAll}>
            Export all (copy JSON)
          </button>
          <button className="btn ghost" disabled={busy || !list} onClick={() => setImportText(importText === null ? '' : null)}>
            Import
          </button>
        </div>
      )}
      {importText !== null && editor === null && (
        <div className="recipe-editor">
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={10} spellCheck={false} placeholder="Paste a JSON list of recipes; this replaces the saved list." autoCapitalize="off" autoCorrect="off" />
          <div className="actions">
            <button className="btn ghost" disabled={busy} onClick={() => setImportText(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy} onClick={doImport}>
              Import and replace
            </button>
          </div>
        </div>
      )}
      <p className="hint">
        Variables: {'{brief}'} plus {'{member.cwd}'}, {'{member.worktree}'}, {'{member.branch}'}, {'{member.title}'} in member prompts and handoff templates.
      </p>
    </div>
  );
}
