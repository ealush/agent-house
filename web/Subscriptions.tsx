import { useEffect, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import { api, type Subscription } from './api.ts';
import { askConfirm, showError } from './ask.tsx';
import { errorText } from './errors.ts';
import { reviewApi } from './reviewApi.ts';

const review = reviewApi();

// Chat subscriptions (BYOK): named OpenAI-compatible endpoints whose keys
// live on the host beside ah's other secrets. Listed without keys; blank key
// on edit keeps the stored one. A subscription can also hand its key to
// sessions as an environment variable (Settings → Environment).
export function SubscriptionsPanel() {
  const [list, setList] = useState<Subscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** keyHint: the stored key, masked, shown in the empty key field while editing. */
  const [form, setForm] = useState<{ id?: string; name: string; baseUrl: string; model: string; apiKey: string; keyHint: string; envName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [summaryId, setSummaryId] = useState<string | null>(null);

  const load = () => {
    api.subscriptions().then(setList).catch((e) => setError(e.message));
    review.settings().then((s) => setSummaryId(s.summaryId), () => {});
  };
  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!form || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveSubscription({
        ...(form.id ? { id: form.id } : {}),
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        envName: form.envName.trim(),
      });
      setForm(null);
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: Subscription) {
    if (!(await askConfirm({ title: `Delete "${s.name}"?`, body: "Side chats keep their history but can't continue on it.", confirm: 'Delete', danger: true }))) return;
    try {
      await api.removeSubscription(s.id);
      load();
    } catch (e) {
      showError(e, "Couldn't delete the subscription");
    }
  }

  async function makeDefault(s: Subscription) {
    try {
      await api.defaultSubscription(s.id);
      load();
    } catch (e) {
      showError(e, "Couldn't change the default");
    }
  }

  return (
    <div className="sec-card" data-confirm>
      <h2>Chat subscriptions</h2>
      <p className="hint">
        Side chat and Review's reviewer talk to these endpoints. A cheaper model can write Review's briefings and re-checks. Keys are stored on this host only, alongside ah's other secrets, and once saved show
        only their first and last few characters. Any OpenAI-compatible API works: OpenAI, Grok, Gemini, DeepSeek, Ollama.
      </p>
      {error && <p className="form-error">{error}</p>}
      {!list && !error && <p className="hint">Loading…</p>}
      {list && list.length > 0 && (
        <ul className="worktrees">
          {list.map((s) => (
            <li key={s.id}>
              <div className="stack">
                <span>
                  {s.name} {s.isDefault && <span className="hint">· default</span>}
                </span>
                <span className="sub">
                  {s.model} · {s.baseUrl.replace(/^https?:\/\//, '').split('/')[0]}
                </span>
                <span className="sub">
                  {s.hasKey ? <span className="mono">{s.keyHint}</span> : 'No key'}
                  {s.envName && <> · sessions get it as <span className="mono">{s.envName}</span></>}
                </span>
              </div>
              {!s.isDefault && (
                <button className="btn small" disabled={busy} onClick={() => makeDefault(s)}>
                  Default
                </button>
              )}
              <button
                className="btn small"
                disabled={busy}
                onClick={() => setForm({ id: s.id, name: s.name, baseUrl: s.baseUrl, model: s.model, apiKey: '', keyHint: s.keyHint, envName: s.envName ?? '' })}
              >
                Edit
              </button>
              <button className="btn ghost small danger" disabled={busy} onClick={() => remove(s)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {list && list.length > 1 && (
        <label className="field">
          <span>Review briefings and re-checks</span>
          <select
            value={summaryId ?? ''}
            onChange={(e) =>
              review
                .setSummaryModel(e.target.value || null)
                .then((s) => setSummaryId(s.summaryId))
                .catch((err) => showError(err, "Couldn't change it"))
            }
          >
            <option value="">The default</option>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.model}
              </option>
            ))}
          </select>
        </label>
      )}
      {form ? (
        <div className="form-grid">
          <label className="field">
            <span>Name</span>
            <input value={form.name} disabled={busy} maxLength={80} placeholder="OpenAI" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={form.model} disabled={busy} maxLength={80} placeholder="gpt-4o" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </label>
          <label className="field wide">
            <span>Base URL</span>
            <input
              value={form.baseUrl}
              disabled={busy}
              maxLength={200}
              placeholder="https://api.openai.com/v1"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </label>
          <label className="field">
            <span>API key</span>
            <input
              type="password"
              value={form.apiKey}
              disabled={busy}
              maxLength={500}
              autoComplete="off"
              placeholder={form.keyHint || undefined}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
            {form.keyHint && <small className="field-hint">Saved. Type a new key to replace it.</small>}
          </label>
          <label className="field">
            <span>Session variable</span>
            <input
              value={form.envName}
              disabled={busy}
              maxLength={128}
              placeholder="Optional, e.g. OPENAI_API_KEY"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setForm({ ...form, envName: e.target.value })}
            />
            <small className="field-hint">Sessions get the key under this name.</small>
          </label>
        </div>
      ) : (
        <button
          className="btn small"
          onClick={() => setForm({ name: '', baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '', keyHint: '', envName: '' })}
        >
          Add subscription
        </button>
      )}
      {form && (
        <div className="actions">
          <button className="btn ghost small" disabled={busy} onClick={() => setForm(null)}>
            Cancel
          </button>
          <ConfirmButton className="btn primary small" disabled={busy || !form.name.trim() || !form.baseUrl.trim() || !form.model.trim() || (!form.id && !form.apiKey)} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}
