// ---------- unified diff → files / lines with real line numbers

export type Line = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; n: number | null };
export type FileDiff = { path: string; add: number; del: number; lines: Line[] };

export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | null = null;
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      f = { path: raw.split(' b/').slice(1).join(' b/') || raw, add: 0, del: 0, lines: [] };
      files.push(f);
    } else if (!f || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) {
      continue;
    } else if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      oldN = Number(m?.[1] ?? 0);
      newN = Number(m?.[2] ?? 0);
      // A hunk names the function it's in when git knows it, else where it starts. The first
      // hunk of a file that starts at its top says nothing the lines under it don't.
      const context = raw.replace(/^@@[^@]*@@\s?/, '').trim();
      if (context || f.lines.length > 0 || newN > 1) f.lines.push({ kind: 'hunk', text: context ? `… ${context}` : `Line ${newN}`, n: null });
    } else if (raw.startsWith('+')) {
      f.add++;
      f.lines.push({ kind: 'add', text: raw.slice(1), n: newN++ });
    } else if (raw.startsWith('-')) {
      f.del++;
      f.lines.push({ kind: 'del', text: raw.slice(1), n: oldN++ });
    } else if (raw.startsWith(' ')) {
      f.lines.push({ kind: 'ctx', text: raw.slice(1), n: newN++ });
      oldN++;
    }
  }
  return files;
}
