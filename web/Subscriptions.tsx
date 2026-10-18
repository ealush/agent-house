import { useEffect, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import { look } from './agents.ts';
import { api, type Subscription } from './api.ts';
import { askConfirm, showError } from './ask.tsx';
import { errorText } from './errors.ts';
import { Icon } from './icons.tsx';
import { AgentLogo } from './logos.tsx';
import { blank, OTHER, PROVIDERS, providerFor, switchProvider, type Form } from './providers.ts';
import { reviewApi } from './reviewApi.ts';
import { radioGridMove } from './rove.ts';
import { SubscriptionMark } from './SubscriptionPicker.tsx';

const review = reviewApi();

const host = (url: string) => url.replace(/^https?:\/\//, '').split('/')[0];

// Chat subscriptions (BYOK): named OpenAI-compatible endpoints whose keys
// live on the host beside ah's other secrets. Listed without keys; blank key
// on edit keeps the stored one. A subscription can also hand its key to
// sessions as an environment variable (Settings → Environment). New ones start
// from a provider (providers.ts) that fills in its endpoint and a model.
export function SubscriptionsPanel() {
  const [list, setList] = useState<Subscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** keyHint: the stored key, masked, shown in the empty key field while editing. */
  const [form, setForm] = useState<Form | null>(null);
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
      showError(e, "Couldn't change the active subscription");
    }
  }

  return (
    <div className="sec-card" data-confirm>
      <h2>Chat subscriptions</h2>
      <p className="hint">
        Side chat and Review's reviewer talk to these endpoints. A cheaper model can write Review's briefings and re-checks. Keys are stored on this host only, alongside ah's other secrets, and once saved show
        only their first and last few characters. Pick Claude, OpenAI, Gemini or Muse and ah fills in the rest; Other takes any OpenAI-compatible API, such as Grok, DeepSeek or Ollama.
      </p>
      {list && list.length > 1 && (
        <p className="hint">
          The <b>active</b> one answers everywhere you haven't picked another. A side chat or Review thread can switch from its own menu and keeps that pick.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      {!list && !error && <p className="hint">Loading…</p>}
      {list && list.length > 0 && (
        <ul className="worktrees subs" role={list.length > 1 ? 'radiogroup' : undefined} aria-label="Active subscription">
          {list.map((s) => (
            <li key={s.id}>
              {/* The row is the radio: the active one answers wherever nothing else is picked. */}
              <button
                type="button"
                className={`sub-choose ${s.isDefault ? 'on' : ''}`}
                role={list.length > 1 ? 'radio' : undefined}
                aria-checked={list.length > 1 ? s.isDefault : undefined}
                disabled={busy}
                title={s.isDefault ? 'Active' : `Make ${s.name} active`}
                onClick={() => !s.isDefault && makeDefault(s)}
              >
                {list.length > 1 && <span className="radio" aria-hidden />}
                <SubscriptionMark s={s} size={15} />
                <span className="stack">
                  <span>
                    {s.name} {s.isDefault && list.length > 1 && <span className="active-tag">Active</span>}
                  </span>
                  <span className="sub">
                    {s.model} · {host(s.baseUrl)}
                  </span>
                  <span className="sub">
                    {s.hasKey ? <span className="mono">{s.keyHint}</span> : 'No key'}
                    {s.envName && <> · sessions get it as <span className="mono">{s.envName}</span></>}
                  </span>
                </span>
              </button>
              <button
                className="btn small"
                disabled={busy}
                onClick={() => setForm({ id: s.id, provider: providerFor(s.baseUrl), name: s.name, baseUrl: s.baseUrl, model: s.model, apiKey: '', keyHint: s.keyHint, envName: s.envName ?? '' })}
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
            <option value="">The active one</option>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.model}
              </option>
            ))}
          </select>
        </label>
      )}
      {form ? (
        <SubscriptionForm form={form} busy={busy} onChange={setForm} />
      ) : (
        <button className="btn small" onClick={() => setForm(blank(PROVIDERS[0].id))}>
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

/** The add/edit fields. Adding starts with a provider; editing keeps the endpoint it has. */
function SubscriptionForm({ form, busy, onChange }: { form: Form; busy: boolean; onChange: (f: Form) => void }) {
  const provider = PROVIDERS.find((p) => p.id === form.provider);
  const set = (patch: Partial<Form>) => onChange({ ...form, ...patch });
  const models = useModels(form);
  /** Typing a model id by hand instead of picking one the endpoint listed. */
  const [typing, setTyping] = useState(false);
  const picking = !!models.list?.length && !typing;
  return (
    <div className="form-grid">
      {!form.id && (
        <div className="field wide">
          <span>Provider</span>
          <div className="agent-pick">
            <div
              className="agents providers"
              role="radiogroup"
              aria-label="Provider"
              onKeyDown={(e) => {
                if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                const next = radioGridMove(e.currentTarget, e.target as HTMLElement, e.key);
                if (!next || next === e.target) return;
                e.preventDefault();
                next.focus();
                next.click();
              }}
            >
              {[...PROVIDERS.map((p) => ({ id: p.id, name: p.name, logo: p.logo })), { id: OTHER, name: 'Other', logo: '' }].map((p) => {
                const on = p.id === form.provider;
                return (
                  <button
                    type="button"
                    key={p.id}
                    role="radio"
                    aria-checked={on}
                    className={`agent-pill ${on ? 'on' : ''}`}
                    tabIndex={on ? 0 : -1}
                    disabled={busy}
                    style={{ '--agent': p.logo ? look(p.logo).color : 'var(--accent)' } as React.CSSProperties}
                    onClick={() => !on && onChange(switchProvider(form, p.id))}
                  >
                    <span className="chip sm">{p.logo ? <AgentLogo id={p.logo} size={13} /> : <Icon name="globe" size={13} />}</span>
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
          {provider && (
            <small className="field-hint">
              Talks to <span className="mono">{host(provider.baseUrl)}</span>.{' '}
              <a href={provider.keyUrl} target="_blank" rel="noreferrer">
                Get an API key
              </a>
            </small>
          )}
        </div>
      )}
      <label className="field">
        <span>Name</span>
        <input value={form.name} disabled={busy} maxLength={80} placeholder={provider?.name ?? 'OpenRouter'} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="field">
        <span>Model</span>
        {picking ? (
          <select className="mono" value={form.model} disabled={busy} onChange={(e) => (e.target.value === TYPE ? setTyping(true) : set({ model: e.target.value }))}>
            {!models.list!.includes(form.model) && <option value={form.model}>{form.model || 'Choose a model'}</option>}
            {models.list!.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={TYPE}>Type a model id…</option>
          </select>
        ) : (
          <input
            className="mono"
            value={form.model}
            disabled={busy}
            maxLength={80}
            placeholder={provider?.model ?? 'model id'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => set({ model: e.target.value })}
          />
        )}
        <small className="field-hint" aria-live="polite">
          {models.state === 'loading' && <>Asking {host(form.baseUrl)} for its models…</>}
          {models.state === 'error' && <>Couldn't list its models: {models.error}</>}
          {models.state === 'idle' && !form.keyHint && <>Add the key to pick from its models.</>}
          {models.state === 'done' && (models.list!.length === 0 ? <>It lists no chat models; type one.</> : picking ? <>{models.list!.length} from {host(form.baseUrl)}.</> : (
            <button type="button" className="linkish" onClick={() => setTyping(false)}>
              Pick from its {models.list!.length} models
            </button>
          ))}
        </small>
      </label>
      {(!provider || form.id) && (
        <label className="field wide">
          <span>Base URL</span>
          <input
            className="mono"
            value={form.baseUrl}
            disabled={busy}
            maxLength={200}
            placeholder="https://api.example.com/v1"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => set({ baseUrl: e.target.value })}
          />
          {!form.id && <small className="field-hint">Any endpoint that speaks OpenAI's chat completions API.</small>}
        </label>
      )}
      <label className="field">
        <span>API key</span>
        <input
          className="mono"
          type="password"
          value={form.apiKey}
          disabled={busy}
          maxLength={500}
          autoComplete="off"
          placeholder={form.keyHint || undefined}
          onChange={(e) => set({ apiKey: e.target.value })}
        />
        {form.keyHint && <small className="field-hint">Saved. Type a new key to replace it.</small>}
      </label>
      <label className="field">
        <span>Session variable</span>
        <input
          className="mono"
          value={form.envName}
          disabled={busy}
          maxLength={128}
          placeholder={`Optional, e.g. ${provider?.envName ?? 'OPENAI_API_KEY'}`}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => set({ envName: e.target.value })}
        />
        <small className="field-hint">Sessions get the key under this name.</small>
      </label>
    </div>
  );
}

/** The model select's "type one by hand" option. */
const TYPE = '\u0000type';

type Models = { state: 'idle' | 'loading' | 'done' | 'error'; list: string[] | null; error?: string };

/**
 * The models the form's endpoint offers, asked for once a key is typed (or,
 * editing, with the saved key at the saved URL), a moment after typing stops.
 */
function useModels(form: Form): Models {
  const [models, setModels] = useState<Models>({ state: 'idle', list: null });
  const seq = useRef(0);
  const { baseUrl, apiKey, id } = form;
  useEffect(() => {
    const n = ++seq.current;
    const ready = /^https?:\/\/[^/]+/.test(baseUrl.trim()) && (apiKey.length >= 8 || (!apiKey && !!id));
    setModels({ state: ready ? 'loading' : 'idle', list: null });
    if (!ready) return;
    const t = setTimeout(() => {
      api
        .subscriptionModels({ baseUrl: baseUrl.trim(), ...(apiKey ? { apiKey } : { id }) })
        .then((r) => n === seq.current && setModels({ state: 'done', list: r.models }))
        .catch((e) => n === seq.current && setModels({ state: 'error', list: null, error: errorText(e) }));
    }, 500);
    return () => clearTimeout(t);
  }, [baseUrl, apiKey, id]);
  return models;
}
