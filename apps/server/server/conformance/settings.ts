// The conformance suite on an agent CLI's update (server/conformance.ts): config.json's `conformance`.
export type ConformanceConfig = {
  /** On unless set false: a new version of an agent's CLI is run through the suite, and you're told when it fails. */
  onUpdate: boolean;
  /** The agents it covers (the ones its scenarios know). */
  agents: string[];
};

export const DEFAULT_CONFORMANCE: ConformanceConfig = { onUpdate: true, agents: ['claude', 'codex', 'gemini', 'grok', 'muse'] };

/** Settings from config.json's `conformance`, each one that isn't valid at its default. */
export function conformanceConfig(user: Partial<ConformanceConfig> | undefined): ConformanceConfig {
  const out = { ...DEFAULT_CONFORMANCE, agents: [...DEFAULT_CONFORMANCE.agents] };
  if (typeof user?.onUpdate === 'boolean') out.onUpdate = user.onUpdate;
  if (Array.isArray(user?.agents) && user.agents.every((a) => typeof a === 'string')) out.agents = [...user.agents];
  return out;
}
