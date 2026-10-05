import { useState } from 'react';
import { patchLines, type DiffLine } from './diff.ts';

const PREVIEW = 40;

export function DiffView({ patch, lines }: { patch?: string; lines?: DiffLine[] }) {
  const all = lines ?? patchLines(patch ?? '');
  const [full, setFull] = useState(false);
  const shown = full ? all : all.slice(0, PREVIEW);
  if (!all.length) return <pre className="code-block">{patch}</pre>;
  return (
    <div className="gui-diff">
      {shown.map((l, i) =>
        l.kind === 'file' ? (
          <div key={i} className="gui-diff-file mono">
            {l.text}
          </div>
        ) : (
          <div key={i} className={`dl ${l.kind}`}>
            <span className="ln">{l.n ?? ''}</span>
            <span className="code">{l.text || ' '}</span>
          </div>
        ),
      )}
      {all.length > PREVIEW && (
        <button className="btn ghost small more" onClick={() => setFull(!full)}>
          {full ? 'Show less' : `Show all ${all.length} lines`}
        </button>
      )}
    </div>
  );
}
