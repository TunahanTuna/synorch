import type { UsageRowView, UsageView } from "../../contracts/views.ts";
import { clean, displayWidth, finish, formatCount, formatElapsed, formatTokens, formatUsd, meterBar, padEnd, padStart, shareBar, type ViewContext } from "./kit.ts";

/**
 * `/usage` (X7, UX-10): what this session (and today) consumed, per model, provider and tier.
 * API keys show dollars (`~` when estimated, never fake precision); subscriptions show `plan`
 * and their quota windows as meters. Tiny share bars use unicode blocks (halves in `safe`, `#` in
 * `ascii`). Columns drop right-to-left on narrow terminals.
 */

interface Totals {
  requests: number;
  input: number;
  output: number;
  cache: number;
  cost: number;
  estimated: boolean;
  anyCost: boolean;
  subscription: boolean;
}

function empty(): Totals {
  return { requests: 0, input: 0, output: 0, cache: 0, cost: 0, estimated: false, anyCost: false, subscription: false };
}

function add(totals: Totals, row: UsageRowView): Totals {
  totals.requests += row.requests;
  totals.input += row.inputTokens;
  totals.output += row.outputTokens;
  totals.cache += (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
  if (row.costUsd !== undefined) {
    totals.cost += row.costUsd;
    totals.anyCost = true;
  }
  if (row.costEstimated === true) totals.estimated = true;
  if (row.billing === "subscription") totals.subscription = true;
  return totals;
}

function sum(rows: readonly UsageRowView[]): Totals {
  return rows.reduce(add, empty());
}

function groupBy(rows: readonly UsageRowView[], key: (row: UsageRowView) => string): Map<string, Totals> {
  const groups = new Map<string, Totals>();
  for (const row of rows) {
    const name = key(row);
    groups.set(name, add(groups.get(name) ?? empty(), row));
  }
  return groups;
}

function costCell(totals: Totals): string {
  if (totals.anyCost) return formatUsd(totals.cost, totals.estimated);
  return totals.subscription ? "plan" : "-";
}

function rowCost(row: UsageRowView): string {
  if (row.costUsd !== undefined) return formatUsd(row.costUsd, row.costEstimated === true);
  return row.billing === "subscription" ? "plan" : "-";
}

interface Column {
  readonly title: string;
  readonly width: number;
  readonly align: "left" | "right";
  /** Lower drops first on narrow terminals. */
  readonly priority: number;
}

export function renderUsage(view: UsageView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const width = ctx.width;
  const sep = g.base.sep;
  const lines: string[] = [];
  const elapsed = view.sessionElapsedMs === undefined ? "" : ` ${sep} ${formatElapsed(view.sessionElapsedMs)}`;
  lines.push(t.accent(`${g.base.bullet} Usage ${sep} this session${elapsed}${view.today === undefined ? "" : " vs today"}`));
  if (view.session.length === 0 && (view.today ?? []).length === 0) {
    lines.push(t.muted("  no model requests yet"));
    return lines;
  }

  // Per-model table.
  const labelOf = (row: UsageRowView) => `${clean(row.provider, 24)} ${clean(row.model, 32)}`;
  const labelWidth = Math.min(28, Math.max(5, ...view.session.map((row) => displayWidth(labelOf(row))), displayWidth("total")));
  const all: Column[] = [
    { title: "model", width: labelWidth, align: "left", priority: 9 },
    { title: "tier", width: Math.min(10, Math.max(4, ...view.session.map((row) => displayWidth(clean(row.tier, 10))))), align: "left", priority: 2 },
    { title: "req", width: 5, align: "right", priority: 7 },
    { title: "in", width: 6, align: "right", priority: 8 },
    { title: "out", width: 6, align: "right", priority: 8 },
    { title: "cache", width: 6, align: "right", priority: 3 },
    { title: "cost", width: 7, align: "right", priority: 9 },
    { title: "share", width: 8, align: "left", priority: 1 },
  ];
  let columns = all;
  const used = (cols: readonly Column[]) => 2 + cols.reduce((total, col) => total + col.width + 1, 0);
  for (const priority of [1, 2, 3, 7]) if (used(columns) > width) columns = columns.filter((col) => col.priority !== priority);
  const cell = (col: Column, text: string) => (col.align === "left" ? padEnd(text, col.width) : padStart(text, col.width));
  lines.push(t.muted(`  ${columns.map((col) => cell(col, col.title === "share" ? "" : col.title)).join(" ")}`));
  const sessionTotals = sum(view.session);
  const totalTokens = sessionTotals.input + sessionTotals.output;
  for (const row of view.session) {
    const values: Record<string, string> = {
      model: labelOf(row),
      tier: clean(row.tier, 10),
      req: formatCount(row.requests),
      in: formatTokens(row.inputTokens),
      out: formatTokens(row.outputTokens),
      cache: formatTokens((row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0)),
      cost: rowCost(row),
      share: "",
    };
    const text = columns
      .map((col) => {
        if (col.title === "share") return t.accent(padEnd(shareBar(totalTokens === 0 ? 0 : (row.inputTokens + row.outputTokens) / totalTokens, col.width, g), col.width));
        const value = cell(col, values[col.title] ?? "");
        return col.title === "model" ? value : col.title === "cost" && row.costUsd === undefined ? t.muted(value) : value;
      })
      .join(" ");
    lines.push(`  ${text}`);
  }
  if (view.session.length > 1) {
    const values: Record<string, string> = {
      model: "total",
      tier: "",
      req: formatCount(sessionTotals.requests),
      in: formatTokens(sessionTotals.input),
      out: formatTokens(sessionTotals.output),
      cache: formatTokens(sessionTotals.cache),
      cost: costCell(sessionTotals),
      share: "",
    };
    lines.push(t.bold(`  ${columns.map((col) => cell(col, values[col.title] ?? "")).join(" ")}`));
  }

  // By provider and by tier: session vs today, tokens (in + out) with share bars.
  const today = view.today;
  const groupSection = (title: string, key: (row: UsageRowView) => string) => {
    const sessionGroups = groupBy(view.session, key);
    const todayGroups = today === undefined ? undefined : groupBy(today, key);
    const names = [...new Set([...sessionGroups.keys(), ...(todayGroups?.keys() ?? [])])];
    if (names.length < 2 && title !== "provider") return;
    const nameWidth = Math.min(16, Math.max(displayWidth(`by ${title}`), ...names.map((name) => displayWidth(name))));
    const barWidth = Math.max(4, Math.min(12, Math.floor((width - 2 - nameWidth - 1 - (todayGroups === undefined ? 7 : 2 * 7 + 1)) / (todayGroups === undefined ? 1 : 2)) - 1));
    const todayMax = Math.max(1, ...[...(todayGroups?.values() ?? [])].map((group) => group.input + group.output));
    const sessionMax = Math.max(1, ...[...sessionGroups.values()].map((group) => group.input + group.output));
    lines.push("");
    const header = `  ${padEnd(`by ${title}`, nameWidth)} ${padEnd("session", barWidth + 7)}${todayGroups === undefined ? "" : ` ${padEnd("today", barWidth + 7)}`}`;
    lines.push(t.muted(header.trimEnd()));
    for (const name of names) {
      const s = sessionGroups.get(name) ?? empty();
      const sTokens = s.input + s.output;
      let line = `  ${padEnd(name, nameWidth)} ${t.accent(padEnd(shareBar(sTokens / sessionMax, barWidth, g), barWidth))} ${padStart(formatTokens(sTokens), 6)}`;
      if (todayGroups !== undefined) {
        const d = todayGroups.get(name) ?? empty();
        const dTokens = d.input + d.output;
        line += ` ${t.muted(padEnd(shareBar(dTokens / todayMax, barWidth, g), barWidth))} ${padStart(formatTokens(dTokens), 6)}`;
      }
      lines.push(line);
    }
  };
  groupSection("provider", (row) => clean(row.provider, 16));
  groupSection("tier", (row) => clean(row.tier, 16) || "other");

  // Quotas of subscriptions.
  const quotas = view.quotas ?? [];
  if (quotas.length > 0) {
    lines.push("");
    lines.push(t.muted("  quota"));
    // One block per provider: `chatgpt  ChatGPT Plus · 12 req (8 by workers)`, then its windows as meters.
    const labelW = Math.min(14, Math.max(6, ...quotas.map((quota) => displayWidth(clean(quota.window, 12)))));
    const meterW = Math.max(6, Math.min(20, width - 4 - labelW - 1 - 5 - 16));
    let provider: string | undefined;
    for (const quota of quotas) {
      if (quota.provider !== provider) {
        provider = quota.provider;
        const requests = quota.requests === undefined ? undefined : `${formatCount(quota.requests.total)} req${quota.requests.workers > 0 ? ` (${formatCount(quota.requests.workers)} by workers)` : ""}`;
        const detail = [quota.plan === undefined ? undefined : clean(quota.plan, 40), requests].filter((part): part is string => part !== undefined).join(` ${sep} `);
        lines.push(`  ${t.accent(clean(provider, 16))}${detail === "" ? "" : t.muted(`  ${detail}`)}`);
      }
      if (quota.usedPercent === undefined) {
        lines.push(t.muted("    quota not reported yet"));
        continue;
      }
      const percent = Math.round(Math.min(100, Math.max(0, quota.usedPercent)));
      const meter = meterBar(percent / 100, meterW, g);
      const tone = percent >= 90 ? t.error : percent >= 70 ? t.warning : t.success;
      const resets = quota.resetsAt === undefined ? "" : t.muted(` resets ${clean(quota.resetsAt, 20)}`);
      lines.push(`    ${padEnd(clean(quota.window, 12), labelW)} ${tone(meter.filled)}${t.muted(meter.empty)} ${padStart(`${percent}%`, 4)}${resets}`);
    }
  }

  if (view.budget !== undefined && view.budget.limitUsd > 0) {
    const ratio = view.budget.usedUsd / view.budget.limitUsd;
    const meter = meterBar(ratio, 12, g);
    const tone = ratio >= 0.9 ? t.error : ratio >= 0.7 ? t.warning : t.success;
    lines.push("");
    lines.push(`  ${padEnd("budget", 8)} ${tone(meter.filled)}${t.muted(meter.empty)} ${formatUsd(view.budget.usedUsd)} of ${formatUsd(view.budget.limitUsd)}`);
  }

  // Today vs session totals, one line each.
  lines.push("");
  const summary = (label: string, totals: Totals) =>
    `  ${padEnd(label, 8)} ${formatCount(totals.requests)} req ${sep} ${formatTokens(totals.input)} in ${sep} ${formatTokens(totals.output)} out ${sep} ${formatTokens(totals.cache)} cache ${sep} ${costCell(totals)}`;
  lines.push(summary("session", sessionTotals));
  if (today !== undefined) lines.push(t.muted(summary("today", sum(today))));
  if (sessionTotals.estimated) lines.push(t.muted("  ~ estimated from token counts; the provider's bill is authoritative"));
  return finish(lines, ctx);
}
