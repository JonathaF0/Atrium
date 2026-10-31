"use client";

/**
 * Small inline-SVG charts for the reports. Each mark carries a <title> so the
 * browser shows its value on hover; the tables under each chart hold the same data.
 */

export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#6250d6"] as const;

export interface ChartSeries {
  key: string;
  label: string;
}

export interface ChartPoint {
  label: string;
  values: number[];
}

const WIDTH = 720;
const HEIGHT = 200;
const PAD = { top: 10, right: 8, bottom: 22, left: 40 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function Legend({ series }: { series: ChartSeries[] }): React.ReactElement | null {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-4 text-xs text-[var(--muted-foreground)] mb-1">
      {series.map((s, i) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: SERIES_COLORS[i] }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function Axis({ max, format }: { max: number; format: (v: number) => string }): React.ReactElement {
  const ticks = [0, max / 2, max];
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  return (
    <g>
      {ticks.map((t) => {
        const y = PAD.top + plotH - (t / max) * plotH;
        return (
          <g key={t}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--muted-foreground)">
              {format(t)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Which x labels to print so they don't collide. */
function labelEvery(n: number): number {
  return Math.max(1, Math.ceil(n / 10));
}

/** Grouped columns, one group per point, one column per series. */
export function ColumnChart({
  series,
  points,
  format = (v) => String(Math.round(v)),
  ariaLabel,
}: {
  series: ChartSeries[];
  points: ChartPoint[];
  format?: (v: number) => string;
  ariaLabel: string;
}): React.ReactElement {
  const max = niceMax(Math.max(0, ...points.flatMap((p) => p.values)));
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const groupW = plotW / Math.max(1, points.length);
  const gap = Math.min(4, groupW * 0.2);
  const barW = Math.max(1, (groupW - gap) / series.length - (series.length > 1 ? 1 : 0));
  const every = labelEvery(points.length);
  return (
    <div>
      <Legend series={series} />
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-auto" role="img" aria-label={ariaLabel}>
        <Axis max={max} format={format} />
        {points.map((p, i) => {
          const x0 = PAD.left + i * groupW + gap / 2;
          return (
            <g key={p.label}>
              {p.values.map((v, j) => {
                const h = (v / max) * plotH;
                return (
                  <rect
                    key={series[j].key}
                    x={x0 + j * (barW + 1)}
                    y={PAD.top + plotH - h}
                    width={barW}
                    height={Math.max(0, h)}
                    rx={Math.min(2, barW / 2)}
                    fill={SERIES_COLORS[j]}
                  >
                    <title>{`${p.label} · ${series[j].label}: ${format(v)}`}</title>
                  </rect>
                );
              })}
              {i % every === 0 && (
                <text
                  x={x0 + (groupW - gap) / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--muted-foreground)"
                >
                  {p.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** A single-series line. */
export function LineChart({
  points,
  label,
  format = (v) => String(Math.round(v)),
}: {
  points: { label: string; value: number }[];
  label: string;
  format?: (v: number) => string;
}): React.ReactElement {
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const xy = points.map((p, i) => ({
    x: PAD.left + (points.length > 1 ? i * step : plotW / 2),
    y: PAD.top + plotH - (p.value / max) * plotH,
    p,
  }));
  const every = labelEvery(points.length);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full h-auto" role="img" aria-label={label}>
      <Axis max={max} format={format} />
      <polyline
        points={xy.map((d) => `${d.x},${d.y}`).join(" ")}
        fill="none"
        stroke={SERIES_COLORS[0]}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {xy.map((d, i) => (
        <g key={d.p.label}>
          <circle cx={d.x} cy={d.y} r={8} fill="transparent">
            <title>{`${d.p.label}: ${format(d.p.value)}`}</title>
          </circle>
          <circle cx={d.x} cy={d.y} r={points.length > 40 ? 0 : 2.5} fill={SERIES_COLORS[0]} pointerEvents="none" />
          {i % every === 0 && (
            <text x={d.x} y={HEIGHT - 6} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
              {d.p.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** Horizontal bars for a ranked list (category, company, rating …). */
export function BarList({
  rows,
  format = (v) => String(v),
}: {
  rows: { label: string; value: number }[];
  format?: (v: number) => string;
}): React.ReactElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3 text-sm" title={`${r.label}: ${format(r.value)}`}>
          <div className="w-40 shrink-0 truncate">{r.label}</div>
          <div className="flex-1 h-3 rounded bg-[var(--muted)]">
            <div
              className="h-3 rounded"
              style={{ width: `${(r.value / max) * 100}%`, background: SERIES_COLORS[0] }}
            />
          </div>
          <div className="w-20 text-right tabular-nums text-[var(--muted-foreground)]">{format(r.value)}</div>
        </div>
      ))}
    </div>
  );
}

/** Short x-axis label for a bucket key (YYYY-MM-DD). */
export function bucketLabel(key: string, bucket: "day" | "week" | "month"): string {
  const d = new Date(`${key}T00:00:00Z`);
  if (bucket === "month") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
