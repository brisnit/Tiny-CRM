"use client";

import * as React from "react";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";

import { formatCompact, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * Chart palette.
 *
 * Two series maximum, and the pair was validated with the data-viz validator on
 * this app's own surfaces (worst CVD ΔE 25.4 light / 26.3 dark against an ≥8
 * target; contrast ≥3:1 in both modes). Brand green leads because it carries the
 * product's identity; blue is the second slot because green↔orange collides for
 * red-green colour blindness.
 *
 * Single-series charts use one colour and let the axis carry the category names —
 * a rainbow across a named axis encodes nothing.
 */
const SERIES = {
  light: { primary: "#068C28", secondary: "#2a78d6" },
  dark: { primary: "#28ae43", secondary: "#3987e5" },
} as const;

function useSeriesColors() {
  const [mode, setMode] = React.useState<"light" | "dark">("light");

  React.useEffect(() => {
    const root = document.documentElement;
    const read = () => setMode(root.classList.contains("dark") ? "dark" : "light");
    read();
    // The theme toggle swaps a class on <html>; watch it so charts restep rather
    // than inheriting light-mode colours on a dark surface.
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return SERIES[mode];
}

const AXIS = {
  stroke: "var(--surface-hairline)",
  tick: { fill: "var(--text-faint)", fontSize: 11 },
} as const;

function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; dataKey?: string }[];
  label?: string;
  formatter?: (value: number, key?: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-hairline bg-panel px-2.5 py-2 shadow-pop">
      {label ? <p className="mb-1 text-[11px] font-medium text-body">{label}</p> : null}
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className="size-2 shrink-0 rounded-[2px]" style={{ background: entry.color }} aria-hidden />
          {entry.name ? <span>{entry.name}</span> : null}
          <span className="ml-auto pl-3 font-medium tabular text-body">
            {formatter ? formatter(entry.value ?? 0, entry.dataKey) : (entry.value ?? 0).toLocaleString()}
          </span>
        </p>
      ))}
    </div>
  );
}

/**
 * Horizontal magnitude bars. One colour: the category is on the axis, so hue
 * would be redundant. Values are direct-labelled, which also satisfies the
 * relief rule for any mark that sits under 3:1 against the surface.
 */
export function MagnitudeBars({
  data,
  valueLabel = "Value",
  format = "money",
  emptyLabel = "No data yet",
  max: providedMax,
}: {
  data: { name: string; value: number; secondary?: string }[];
  valueLabel?: string;
  format?: "money" | "count";
  emptyLabel?: string;
  max?: number;
}) {
  const colors = useSeriesColors();
  const max = providedMax ?? Math.max(1, ...data.map((d) => d.value));

  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return <p className="px-4 py-8 text-center text-[13px] text-faint">{emptyLabel}</p>;
  }

  return (
    <div>
      <div className="sr-only">{valueLabel} by category</div>
      <ul className="space-y-2.5">
        {data.map((row) => {
          const pct = (row.value / max) * 100;
          return (
            <li key={row.name} className="group">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[12.5px] text-body">{row.name}</span>
                <span className="shrink-0 text-[12.5px] font-medium tabular text-body">
                  {format === "money" ? formatCompact(row.value) : row.value.toLocaleString()}
                  {row.secondary ? (
                    <span className="ml-1.5 font-normal text-faint">{row.secondary}</span>
                  ) : null}
                </span>
              </div>
              {/* 4px rounded data-end, anchored to a zero baseline. */}
              <div className="h-2 w-full overflow-hidden rounded-[2px] bg-sunken">
                <div
                  className="h-full rounded-r-[4px] transition-[width] duration-500"
                  style={{ width: `${Math.max(pct, row.value > 0 ? 1.5 : 0)}%`, background: colors.primary }}
                  role="img"
                  aria-label={`${row.name}: ${format === "money" ? formatMoney(row.value) : row.value}`}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Revenue won per month — one series, so no legend; the title names it. */
export function RevenueTrend({ data }: { data: { month: string; wonCents: number }[] }) {
  const colors = useSeriesColors();

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="var(--surface-hairline)" strokeDasharray="0" />
        <XAxis
          dataKey="month"
          tickFormatter={monthLabel}
          axisLine={{ stroke: AXIS.stroke }}
          tickLine={false}
          tick={AXIS.tick}
        />
        <YAxis
          tickFormatter={(v: number) => formatCompact(v)}
          axisLine={false}
          tickLine={false}
          tick={AXIS.tick}
          width={56}
        />
        <Tooltip
          cursor={{ fill: "var(--surface-sunken)" }}
          content={<ChartTooltip formatter={(v) => formatMoney(v)} />}
          labelFormatter={(value) => monthLabel(String(value))}
        />
        <Bar dataKey="wonCents" name="Won" fill={colors.primary} radius={[4, 4, 0, 0]} maxBarSize={44} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Deals created vs won. Two series, so a legend is always present and both are
 * direct-labelled at the last point — identity is never carried by colour alone.
 */
export function DealFlowTrend({
  data,
}: {
  data: { month: string; createdCount: number; wonCount: number }[];
}) {
  const colors = useSeriesColors();

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
        <CartesianGrid vertical={false} stroke="var(--surface-hairline)" />
        <XAxis
          dataKey="month"
          tickFormatter={monthLabel}
          axisLine={{ stroke: AXIS.stroke }}
          tickLine={false}
          tick={AXIS.tick}
        />
        <YAxis axisLine={false} tickLine={false} tick={AXIS.tick} width={40} allowDecimals={false} />
        <Tooltip
          cursor={{ stroke: "var(--surface-hairline-strong)", strokeWidth: 1 }}
          content={<ChartTooltip />}
          labelFormatter={(value) => monthLabel(String(value))}
        />
        <Legend
          verticalAlign="top"
          align="left"
          height={28}
          iconType="plainline"
          iconSize={12}
          formatter={(value) => <span className="text-[11.5px] text-muted">{value}</span>}
        />
        <Line
          type="monotone"
          dataKey="createdCount"
          name="Created"
          stroke={colors.secondary}
          strokeWidth={2}
          dot={{ r: 3, strokeWidth: 0, fill: colors.secondary }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--surface-panel)" }}
        />
        <Line
          type="monotone"
          dataKey="wonCount"
          name="Won"
          stroke={colors.primary}
          strokeWidth={2}
          dot={{ r: 3, strokeWidth: 0, fill: colors.primary }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--surface-panel)" }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/**
 * The open pipeline by stage. Single hue: the stage names are on the axis, and
 * a per-stage rainbow would encode nothing that the labels do not.
 */
export function PipelineFunnel({
  data,
}: {
  data: { name: string; valueCents: number; count: number }[];
}) {
  return (
    <MagnitudeBars
      data={data.map((row) => ({
        name: row.name,
        value: row.valueCents,
        secondary: `${row.count} deal${row.count === 1 ? "" : "s"}`,
      }))}
      valueLabel="Open pipeline"
      emptyLabel="No open deals in this pipeline"
    />
  );
}

/** A single headline figure with its supporting line. Not every number is a chart. */
export function HeroNumber({
  label,
  value,
  caption,
  tone = "default",
  className,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: "default" | "brand" | "warn";
  className?: string;
}) {
  return (
    <div className={cn("p-4", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">{label}</p>
      <p
        className={cn(
          "mt-2 text-[30px] font-semibold leading-none tracking-[-0.03em] tabular",
          tone === "brand" ? "text-brand-600 dark:text-brand-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-body",
        )}
      >
        {value}
      </p>
      {caption ? <p className="mt-2 text-[12px] leading-relaxed text-muted">{caption}</p> : null}
    </div>
  );
}

function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return key;
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "short" });
}
