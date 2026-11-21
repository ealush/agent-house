import { useEffect, useMemo, useState } from 'react';
import type { HostApi, State, UsageLimits, UsageReport, UsageRow } from './api.ts';
import { look } from './agents.ts';
import { errorText } from './errors.ts';

const RANGES = [7, 30, 90] as const;
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** 1234567 → "1.2M": counts at a glance (the table has the exact numbers). */
function short(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
const usd = (n: number | null) => (n === null ? '—' : n < 0.01 && n > 0 ? '< $0.01' : `$${n.toFixed(2)}`);
const total = (r: UsageRow) => r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite;
const time = (at: number) => new Date(at * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

type Props = { state: State; client: HostApi; onOpenSession: (uid: string) => void };

/** What the agents on this host used (server/usage): tokens, limits, estimates; each says where it came from. */
export function UsageView({ state, client, onOpenSession }: Props) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [byDay, setByDay] = useState<UsageReport | null>(null);
  const [byModel, setByModel] = useState<UsageReport | null>(null);
  const [bySession, setBySession] = useState<UsageReport | null>(null);
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  useEffect(() => {
    let live = true;
    const from = day(days - 1);
    Promise.all([client.usage({ by: 'day', from }), client.usage({ by: 'model', from }), client.usage({ by: 'session', from }), client.usageLimits()])
      .then(([d, m, s, l]) => live && (setByDay(d), setByModel(m), setBySession(s), setLimits(l), setError(null)))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [client, days]);

  const sum = useMemo(() => {
    const rows = byModel?.rows ?? [];
    const priced = rows.filter((r) => r.cost.estimateUsd !== null);
    return {
      input: rows.reduce((a, r) => a + r.tokens.input + r.tokens.cacheWrite, 0),
      output: rows.reduce((a, r) => a + r.tokens.output, 0),
      cache: rows.reduce((a, r) => a + r.tokens.cacheRead, 0),
      cost: priced.length ? priced.reduce((a, r) => a + (r.cost.estimateUsd ?? 0), 0) : null,
      unpriced: rows.reduce((a, r) => a + r.cost.unpricedTokens, 0),
      billing: [...new Set(priced.map((r) => r.cost.billing).filter(Boolean))],
    };
  }, [byModel]);

  // Agents running here whose transcripts record no usage: said, not counted as zero.
  const unmetered = [...new Set(state.windows.filter((w) => w.agent && w.agent !== 'claude' && w.agent !== 'codex').map((w) => look(w.agent).name))];

  return (
    <div className="page usage-page" data-title="Usage">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">
            Usage<span className="period">.</span>
          </h1>
          <p className="tagline">What the agents on {state.hostname} used, read from their own transcripts. Costs are estimates at list price, not your bill.</p>
        </div>
        <div className="seg" role="radiogroup" aria-label="Period">
          {RANGES.map((n) => (
            <button key={n} role="radio" aria-checked={days === n} className={days === n ? 'on' : ''} onClick={() => setDays(n)}>
              {n} days
            </button>
          ))}
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}

      <div className="stat-tiles">
        <Stat label="Tokens in" value={short(sum.input)} hint="Prompt and cache writes" />
        <Stat label="Tokens out" value={short(sum.output)} hint="Replies, reasoning included" />
        <Stat label="Cache reads" value={short(sum.cache)} hint="Context re-read from cache" />
        <Stat
          label="Estimated API cost"
          value={usd(sum.cost)}
          hint={`${sum.billing.includes('subscription') ? 'Your plan bills differently. ' : ''}At list price${sum.unpriced ? `; ${short(sum.unpriced)} tokens have no price set` : ''}`}
          estimate
        />
      </div>

      <section className="usage-section">
        <div className="usage-section-head">
          <h2 className="section-label">Tokens per day</h2>
          <button className="btn small ghost" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
            {asTable ? 'Show chart' : 'Show table'}
          </button>
        </div>
        {byDay && (asTable ? <DayTable rows={byDay.rows} /> : <DayChart rows={byDay.rows} from={day(days - 1)} days={days} />)}
      </section>

      {limits && (limits.windows.length > 0 || limits.cooldowns.length > 0) && (
        <section className="usage-section">
          <h2 className="section-label">Limits</h2>
          <ul className="usage-limits">
            {limits.windows.map((w) => (
              <li key={`${w.harness}:${w.window}`}>
                <span className="grow">
                  {look(w.harness).name} · {w.window} window{w.windowMinutes ? ` (${w.windowMinutes >= 1440 ? `${Math.round(w.windowMinutes / 1440)} days` : `${Math.round(w.windowMinutes / 60)} h`})` : ''}
                </span>
                <span className="tag">{w.usedPercent === null ? 'use unknown' : `${w.usedPercent}% used`}</span>
                <span className="meta">{w.resetsAt ? `resets ${time(w.resetsAt)}` : ''} · reported by the provider</span>
              </li>
            ))}
            {limits.cooldowns.map((c) => (
              <li key={`cool:${c.uid}`}>
                <button className="link grow" onClick={() => onOpenSession(c.uid)}>
                  {look(c.harness).name}: {c.text}
                </button>
                <span className="meta">{c.resetsAt ? `until ${time(c.resetsAt)}` : 'until unknown'} · {c.source === 'screen' ? 'on its screen' : 'in its transcript'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {byModel && byModel.rows.length > 0 && (
        <section className="usage-section">
          <h2 className="section-label">By model</h2>
          <table className="usage-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>In</th>
                <th>Out</th>
                <th>Cache reads</th>
                <th>Sessions</th>
                <th>Estimate</th>
              </tr>
            </thead>
            <tbody>
              {byModel.rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td>{short(r.tokens.input + r.tokens.cacheWrite)}</td>
                  <td>{short(r.tokens.output)}</td>
                  <td>{short(r.tokens.cacheRead)}</td>
                  <td>{r.sessions}</td>
                  <td title={r.cost.basis ? `${r.cost.basis === 'configured' ? 'Your price' : 'List price'}; billing: ${r.cost.billing}` : 'No price for this model'}>{r.cost.estimateUsd === null ? 'no price' : usd(r.cost.estimateUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {bySession && bySession.rows.length > 0 && (
        <section className="usage-section">
          <h2 className="section-label">Busiest conversations</h2>
          <ul className="usage-limits">
            {bySession.rows.slice(0, 8).map((r) => (
              <li key={r.key}>
                {r.uid ? (
                  <button className="link grow" onClick={() => onOpenSession(r.uid!)}>
                    {state.history.find((h) => h.ref === r.uid)?.title ?? state.windows.find((w) => w.uid === r.uid)?.title ?? r.key}
                  </button>
                ) : (
                  <span className="grow">{r.key}</span>
                )}
                <span className="tag">{short(total(r))} tokens</span>
                <span className="meta">{usd(r.cost.estimateUsd)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="hint">
        {byModel?.notes.tokens} {unmetered.length > 0 && `Running here without usage records: ${unmetered.join(', ')}.`} Export:{' '}
        <a href={client.usageExportUrl('csv')} download>
          CSV
        </a>{' '}
        ·{' '}
        <a href={client.usageExportUrl('json')} download>
          JSON
        </a>
      </p>
    </div>
  );
}

function Stat({ label, value, hint, estimate }: { label: string; value: string; hint: string; estimate?: boolean }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">
        {label}
        {estimate && <span className="tag">estimate</span>}
      </span>
      <span className="stat-value">{value}</span>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}

/** Tokens per day: one series in one hue, thin bars anchored at the baseline, a hover readout. */
function DayChart({ rows, from, days }: { rows: UsageRow[]; from: string; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const byDay = new Map(rows.map((r) => [r.key, r]));
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(d);
    return { day: d, value: r ? total(r) : 0, row: r ?? null };
  });
  const max = Math.max(1, ...series.map((s) => s.value));
  const W = 720;
  const H = 160;
  const pad = { top: 4, bottom: 1, left: 0, right: 0 };
  const slot = (W - pad.left - pad.right) / days;
  const bar = Math.max(2, Math.min(18, slot - 2));
  const y = (v: number) => pad.top + (H - pad.top - pad.bottom) * (1 - v / max);
  const shown = hover === null ? null : series[hover];
  return (
    <figure className="usage-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Tokens per day, last ${days} days; the most was ${short(max)}`} onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={y(max)} y2={y(max)} className="grid" />
        <line x1={0} x2={W} y1={y(max / 2)} y2={y(max / 2)} className="grid" />
        <line x1={0} x2={W} y1={H - pad.bottom} y2={H - pad.bottom} className="axis" />
        {series.map((s, i) => {
          const x = pad.left + i * slot + (slot - bar) / 2;
          const top = y(s.value);
          const h = H - pad.bottom - top;
          const r = Math.min(4, bar / 2, h);
          return (
            <g key={s.day} onMouseEnter={() => setHover(i)}>
              {/* The hit area: the whole column, wider and taller than the bar. */}
              <rect x={pad.left + i * slot} y={pad.top} width={slot} height={H - pad.top - pad.bottom} fill="transparent" />
              {s.value > 0 && <path d={`M${x},${H - pad.bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + bar - r} Q${x + bar},${top} ${x + bar},${top + r} V${H - pad.bottom} Z`} className={`mark ${hover === i ? 'on' : ''}`} />}
            </g>
          );
        })}
      </svg>
      {/* Labels stay at type-scale size while the plot scales with the page. */}
      <div className="usage-axis">
        <span>{series[0]?.day.slice(5)}</span>
        <span>most in a day: {short(max)}</span>
        <span>{series.at(-1)?.day.slice(5)}</span>
      </div>
      <figcaption className="usage-tip" aria-live="polite">
        {shown
          ? shown.row
            ? `${shown.day}: ${short(shown.value)} tokens · in ${short(shown.row.tokens.input + shown.row.tokens.cacheWrite)} · out ${short(shown.row.tokens.output)} · cache reads ${short(shown.row.tokens.cacheRead)}`
            : `${shown.day}: nothing recorded`
          : 'Hover a day for its numbers.'}
      </figcaption>
    </figure>
  );
}

function DayTable({ rows }: { rows: UsageRow[] }) {
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th>Day</th>
          <th>In</th>
          <th>Out</th>
          <th>Cache reads</th>
          <th>Estimate</th>
        </tr>
      </thead>
      <tbody>
        {[...rows].reverse().map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            <td>{(r.tokens.input + r.tokens.cacheWrite).toLocaleString()}</td>
            <td>{r.tokens.output.toLocaleString()}</td>
            <td>{r.tokens.cacheRead.toLocaleString()}</td>
            <td>{usd(r.cost.estimateUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
