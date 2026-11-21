// Spaces' settings (config.json → "spaces"): what config.ts parses into, owned here so
// reading the config never loads the Spaces service.
export type SpacesConfig = {
  /** The Spaces folder: plain Spaces live here, one folder each (docs/spec/17-spaces.md). */
  root: string;
};

export const DEFAULT_SPACES: SpacesConfig = { root: '~/spaces' };
