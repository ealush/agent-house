// What you pick in a layer's diff to ask the reviewer about: a line, or a Shift+click range.

/** A line of a parsed patch (web/Git.tsx): added and context lines carry the new side's number, removed ones the old side's. */
type Line = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; n: number | null };

/** Lines of a diff you're asking about: where, and the text as the diff shows it (+, − or space first). */
export type AskedLines = { path: string; start: number; end: number; text: string; removed: boolean };

const MARK: Record<string, string> = { add: '+', del: '-', ctx: ' ' };

/** Lines i..j of a file's diff (either order): numbered by the new side, or the old one where only removed lines were picked, with their text. */
export function pickedLines(lines: Line[], path: string, i: number, j = i): AskedLines {
  const [a, b] = i <= j ? [i, j] : [j, i];
  const span = lines.slice(a, b + 1).filter((l) => l.kind !== 'hunk');
  // Removed lines count on the old side; mix them in and the numbers stop meaning anything.
  const side = (del: boolean) => span.filter((l) => (l.kind === 'del') === del).map((l) => l.n).filter((n): n is number => n !== null);
  const kept = side(false);
  const nums = kept.length ? kept : side(true);
  return {
    path,
    start: nums[0] ?? 1,
    end: nums.at(-1) ?? 1,
    text: span.slice(0, 200).map((l) => `${MARK[l.kind] ?? ' '}${l.text}`).join('\n'),
    removed: !kept.length,
  };
}
