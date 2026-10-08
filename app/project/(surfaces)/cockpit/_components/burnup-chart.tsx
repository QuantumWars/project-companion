"use client";

import { useMemo, useRef, useState } from "react";

import type { Burnup } from "@/lib/project/sprint";

/**
 * Sprint burn-up: work planned (scope) and work done, day by day.
 *
 * Two series, so a legend is always shown and each line carries its end value.
 * Colours are the `--chart-scope` / `--chart-done` tokens, validated for light
 * and dark with the dataviz palette checks. A crosshair snaps to the nearest
 * day and one tooltip reads both series; the same numbers are in a table for
 * anyone who does not use a pointer.
 */

const W = 640;
const H = 220;
// The right margin holds the end labels ("10 planned"); measured for 3-digit values.
const PAD = { top: 16, right: 96, bottom: 28, left: 36 };

const SERIES = [
  { key: "scope", label: "Planned", color: "rgb(var(--chart-scope))" },
  { key: "done", label: "Done", color: "rgb(var(--chart-done))" },
] as const;

const niceMax = (v: number) => {
  if (v <= 5) return Math.max(1, Math.ceil(v));
  const step = v <= 20 ? 5 : v <= 50 ? 10 : 20;
  return Math.ceil(v / step) * step;
};

const weekday = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });

export const BurnupChart = ({ data }: { data: Burnup }) => {
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pts = data.points;
  const unit = data.unit === "points" ? "points" : "tasks";

  const geo = useMemo(() => {
    const max = niceMax(Math.max(1, ...pts.map((p) => Math.max(p.scope, p.done))));
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (pts.length <= 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
    const ticks = [0, max / 2, max].map((v) => Math.round(v));
    return { max, x, y, ticks, innerW, innerH };
  }, [pts]);

  if (!pts.length) return <p className="text-sm text-fg-muted">The sprint has not started yet.</p>;

  const path = (key: "scope" | "done") => pts.map((p, i) => `${i ? "L" : "M"}${geo.x(i)},${geo.y(p[key])}`).join(" ");
  const area = `${path("done")} L${geo.x(pts.length - 1)},${geo.y(0)} L${geo.x(0)},${geo.y(0)} Z`;
  const last = pts[pts.length - 1];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const sx = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    pts.forEach((_, i) => {
      if (Math.abs(geo.x(i) - sx) < Math.abs(geo.x(best) - sx)) best = i;
    });
    setHover(best);
  };

  // Keep the two end labels apart only when they would touch.
  let scopeY = geo.y(last.scope);
  let doneY = geo.y(last.done);
  if (Math.abs(scopeY - doneY) < 14) {
    if (scopeY <= doneY) doneY = scopeY + 14;
    else scopeY = doneY + 14;
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-x-4 text-xs text-fg-muted" aria-hidden>
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-x-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className="ml-auto">in {unit}</span>
      </div>
      <div className="relative">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none"
          role="img"
          aria-label={`Burn-up: ${last.done} of ${last.scope} ${unit} done by ${last.date}.`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={geo.y(t)} y2={geo.y(t)} stroke="rgb(var(--border))" strokeWidth={1} />
              <text x={PAD.left - 8} y={geo.y(t) + 4} textAnchor="end" className="fill-fg-subtle text-[11px] tabular-nums">
                {t}
              </text>
            </g>
          ))}
          {pts.map((p, i) => (
            <text key={p.date} x={geo.x(i)} y={H - 8} textAnchor="middle" className="fill-fg-subtle text-[11px]">
              {weekday(p.date)}
            </text>
          ))}
          <path d={area} fill="rgb(var(--chart-done) / 0.1)" />
          {SERIES.map((s) => (
            <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {SERIES.map((s) => (
            <circle key={s.key} cx={geo.x(pts.length - 1)} cy={geo.y(last[s.key])} r={4} fill={s.color} stroke="rgb(var(--panel))" strokeWidth={2} />
          ))}
          <text x={geo.x(pts.length - 1) + 10} y={scopeY + 4} className="fill-fg text-[12px] font-medium tabular-nums">
            {last.scope} planned
          </text>
          <text x={geo.x(pts.length - 1) + 10} y={doneY + 4} className="fill-fg text-[12px] font-medium tabular-nums">
            {last.done} done
          </text>
          {hover !== null ? (
            <line x1={geo.x(hover)} x2={geo.x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="rgb(var(--fg-muted))" strokeWidth={1} />
          ) : null}
        </svg>
        {hover !== null ? (
          <div
            className="pointer-events-none absolute top-1 rounded-lg bg-panel-raised px-2.5 py-1.5 text-xs shadow-md ring-1 ring-line"
            style={{ left: `${Math.min(80, (geo.x(hover) / W) * 100)}%` }}
          >
            <p className="mb-1 text-fg-muted">{weekday(pts[hover].date)} {pts[hover].date}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="flex items-center gap-x-2">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                <strong className="tabular-nums text-fg">{pts[hover][s.key]}</strong>
                <span className="text-fg-muted">{s.label.toLowerCase()}</span>
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <details className="mt-2 text-xs text-fg-muted">
        <summary className="cursor-pointer select-none">Show as a table</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead>
            <tr className="text-fg-subtle">
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 font-medium">Planned</th>
              <th className="py-1 font-medium">Done</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.date} className="border-t border-line/60">
                <td className="py-1">{weekday(p.date)} {p.date}</td>
                <td className="py-1">{p.scope}</td>
                <td className="py-1">{p.done}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
};
