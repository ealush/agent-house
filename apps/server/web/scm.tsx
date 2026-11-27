import type { Scm } from './api.ts';
import { Icon } from './icons.tsx';

/** Where a session's checkout stands, in words: for the mark's tooltip and a screen reader. */
export function scmWords(scm: Scm | null | undefined): string {
  if (!scm) return '';
  const words: string[] = [];
  if (scm.dirty > 0) words.push(`${scm.dirty} uncommitted file${scm.dirty === 1 ? '' : 's'}`);
  const p = scm.pull;
  if (p && p.state !== 'closed') {
    const what = p.state === 'merged' ? 'merged' : p.state === 'draft' ? 'draft' : 'open';
    words.push(`PR #${p.number} ${what}${p.state !== 'merged' && p.checks === 'fail' ? ', checks failing' : ''}`);
  }
  return words.join(' · ');
}

/**
 * A session's source control at a glance, faint beside its other marks: a dot for uncommitted
 * changes, and its pull request's glyph (open, draft, failing checks, merged). Nothing for a
 * clean checkout with no pull request, or a closed one.
 */
export function ScmMark({ scm, size = 13 }: { scm: Scm | null | undefined; size?: number }) {
  const words = scmWords(scm);
  if (!scm || !words) return null;
  const p = scm.pull && scm.pull.state !== 'closed' ? scm.pull : null;
  const tone = !p ? '' : p.state === 'merged' ? 'merged' : p.checks === 'fail' ? 'fail' : p.state;
  return (
    <span className="scm-mark" title={words} aria-label={words} role="img">
      {scm.dirty > 0 && <span className="scm-dirty" />}
      {p && (
        <span className={`scm-pull ${tone}`}>
          <Icon name={p.state === 'merged' ? 'merge' : p.state === 'draft' ? 'pull-draft' : 'pull'} size={size} />
        </span>
      )}
    </span>
  );
}
