// Diff shapes agents produce, normalized to numbered lines for DiffView.

export type DiffLine = { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'file'; text: string; n: number | null };

/**
 * Unified diffs in the shapes agents produce: git patches, Codex's `*** Begin Patch`
 * format, or bare +/- hunks. Line numbers follow the new file where hunks carry them.
 */
export function patchLines(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.split('\n')) {
    const file = raw.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/) ?? raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (file) {
      out.push({ kind: 'file', text: file[1], n: null });
    } else if (/^(diff --git |index |--- |\*\*\* (Begin|End) Patch|new file|deleted file|\*\*\* Move to)/.test(raw)) {
      continue;
    } else if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      oldN = Number(m?.[1] ?? 0);
      newN = Number(m?.[2] ?? 0);
      const label = raw.replace(/^@@[^@]*@@\s?/, '').replace(/^@@\s?/, '');
      out.push({ kind: 'hunk', text: label ? `… ${label}` : '…', n: null });
    } else if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), n: newN ? newN++ : null });
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), n: oldN ? oldN++ : null });
    } else if (raw.startsWith(' ')) {
      out.push({ kind: 'ctx', text: raw.slice(1), n: newN ? newN++ : null });
      if (oldN) oldN++;
    }
  }
  return out;
}

/** Claude's `structuredPatch`: hunks with start lines and +/-/space-prefixed lines. */
export function structuredLines(hunks: unknown): DiffLine[] | null {
  if (!Array.isArray(hunks) || !hunks.length) return null;
  const out: DiffLine[] = [];
  for (const h of hunks) {
    if (!Array.isArray(h?.lines)) return null;
    let n = Number(h.newStart) || 0;
    let o = Number(h.oldStart) || 0;
    out.push({ kind: 'hunk', text: '…', n: null });
    for (const l of h.lines as string[]) {
      if (l.startsWith('+')) out.push({ kind: 'add', text: l.slice(1), n: n++ });
      else if (l.startsWith('-')) out.push({ kind: 'del', text: l.slice(1), n: o++ });
      else {
        out.push({ kind: 'ctx', text: l.slice(1), n: n++ });
        o++;
      }
    }
  }
  return out;
}

/** Before/after strings with no hunk information: shown as a replacement. */
export function replaceLines(before: string, after: string): DiffLine[] {
  return [...(before ? before.split('\n').map((text) => ({ kind: 'del' as const, text, n: null })) : []), ...after.split('\n').map((text) => ({ kind: 'add' as const, text, n: null }))];
}
