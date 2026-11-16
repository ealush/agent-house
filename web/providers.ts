// Chat providers a subscription can start from: each one's OpenAI-compatible
// endpoint, a model to start with, and where to get a key. Picking one fills
// the form; everything stays editable. "Other" is any OpenAI-compatible API.
//
// Sources (checked 2026-10-17):
// - Claude: platform.claude.com/docs/en/api/openai-sdk
// - OpenAI: developers.openai.com/api/docs/models
// - Gemini: ai.google.dev/gemini-api/docs/openai
// - Muse: dev.meta.ai/docs/quickstart (Meta Model API)
// - Groq: console.groq.com/docs/models (checked 2026-11-16); also speech to text
//   (whisper-large-v3-turbo) for Voice, docs/spec/14-voice.md

export type Provider = {
  id: string;
  /** The subscription's name when picked. */
  name: string;
  /** AgentLogo id for its mark. */
  logo: string;
  baseUrl: string;
  model: string;
  /** Where to make an API key. */
  keyUrl: string;
  /** The variable its own tools read the key from: a suggestion, never filled in. */
  envName: string;
};

export const PROVIDERS: Provider[] = [
  {
    id: 'claude',
    name: 'Claude',
    logo: 'claude',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5-5',
    keyUrl: 'https://platform.claude.com/settings/keys',
    envName: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    logo: 'codex',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6.1-sol',
    keyUrl: 'https://platform.openai.com/api-keys',
    envName: 'OPENAI_API_KEY',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    logo: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    envName: 'GEMINI_API_KEY',
  },
  {
    id: 'muse',
    name: 'Muse',
    logo: 'muse',
    baseUrl: 'https://api.meta.ai/v1',
    model: 'muse-spark-1.3',
    keyUrl: 'https://dev.meta.ai',
    envName: 'MODEL_API_KEY',
  },
  {
    id: 'groq',
    name: 'Groq',
    // No mark of its own: the globe, as Other has.
    logo: '',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys',
    envName: 'GROQ_API_KEY',
  },
];

/** "Other": any OpenAI-compatible endpoint, typed in. */
export const OTHER = 'other';

const trim = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();

/** The provider a saved base URL belongs to, or OTHER. */
export function providerFor(baseUrl: string): string {
  return PROVIDERS.find((p) => trim(p.baseUrl) === trim(baseUrl))?.id ?? OTHER;
}

/** The subscription form's fields; keyHint is the stored key, masked, while editing. */
export type Form = { id?: string; provider: string; name: string; baseUrl: string; model: string; apiKey: string; keyHint: string; envName: string };

/** A new subscription on `provider`: its endpoint and starting model, or blanks for Other. */
export function blank(provider: string): Form {
  const p = PROVIDERS.find((x) => x.id === provider);
  return { provider, name: p?.name ?? '', baseUrl: p?.baseUrl ?? '', model: p?.model ?? '', apiKey: '', keyHint: '', envName: '' };
}

/**
 * The form moved to another provider: its endpoint always, and its name and
 * model unless they were typed in (no longer the last provider's own).
 */
export function switchProvider(form: Form, to: string): Form {
  const was = blank(form.provider);
  const next = blank(to);
  return {
    ...form,
    provider: to,
    baseUrl: next.baseUrl,
    name: !form.name.trim() || form.name === was.name ? next.name : form.name,
    model: !form.model.trim() || form.model === was.model ? next.model : form.model,
  };
}

/**
 * The mark a subscription shows (an AgentLogo id): its provider's, else one
 * its model names (grok-5 on OpenRouter is still Grok), else null.
 */
export function logoFor(baseUrl: string, model: string): string | null {
  const p = PROVIDERS.find((x) => x.id === providerFor(baseUrl));
  if (p) return p.logo || null;
  const m = model.toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('muse') || m.includes('spark')) return 'muse';
  if (m.includes('grok')) return 'grok';
  if (/(^|\/)(gpt|o\d)/.test(m)) return 'codex';
  return null;
}
