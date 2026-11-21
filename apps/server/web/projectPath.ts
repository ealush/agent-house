// What the New session dialog's Project field means by what was typed in it.

/** The one known project a bare name ("acme-web") stands for, or null. Paths stay as typed. */
export function bareProject(typed: string, projects: string[]): string | null {
  const name = typed.trim();
  if (!name || /[/~]/.test(name)) return null;
  const hits = projects.filter((p) => p.replace(/\/+$/, '').split('/').pop() === name);
  return hits.length === 1 ? hits[0] : null;
}
