import type { ActionView, CriterionStatusView, EvidenceView, ProofView, ReviewVerdictView, WhyView } from "../../contracts/views.ts";
import { paint, type Tone } from "./board.ts";
import { clean, displayWidth, finish, formatElapsed, padEnd, truncate, wrap, type ViewContext } from "./kit.ts";

/**
 * Cards: evidence (`/evidence`, UX-04, X2), action (UX-03) and why (`/why`, X6). Each is compact,
 * keeps the meaning without colour (every status has a word next to its glyph) and never shows an
 * internal id.
 */

const STATUS: { readonly [S in CriterionStatusView]: { readonly word: string; readonly tone: Tone } } = {
  passed: { word: "passed", tone: "success" },
  failed: { word: "failed", tone: "error" },
  not_run: { word: "not run", tone: "warning" },
  unverifiable: { word: "unverifiable", tone: "muted" },
};

function statusGlyph(status: CriterionStatusView, ctx: ViewContext): string {
  const g = ctx.glyphs;
  switch (status) {
    case "passed":
      return g.base.ok;
    case "failed":
      return g.base.fail;
    case "not_run":
      return g.pending;
    case "unverifiable":
      return g.ask;
  }
}

function verdictWord(verdict: ReviewVerdictView): string {
  return verdict === "changes_requested" ? "changes requested" : verdict;
}

function proofLine(proof: ProofView, ctx: ViewContext): { readonly glyph: string; readonly tone: Tone; readonly text: string } {
  const g = ctx.glyphs;
  const sep = ` ${g.base.sep} `;
  switch (proof.kind) {
    case "command": {
      const ok = proof.exitCode === 0;
      const facts: string[] = [];
      if (proof.exitCode !== undefined) facts.push(`exit ${proof.exitCode}`);
      const detail = clean(proof.detail, 60);
      if (detail !== "") facts.push(detail);
      if (proof.durationMs !== undefined) facts.push(formatElapsed(proof.durationMs).replace(/^0s$/, "<1s"));
      facts.push(proof.runBy === "harness" ? "run by Synorch" : "claimed by worker, not run by Synorch");
      const tone: Tone = proof.runBy === "worker" ? "warning" : proof.exitCode === undefined ? "muted" : ok ? "success" : "error";
      const glyph = proof.runBy === "worker" ? g.base.warn : proof.exitCode === undefined ? g.pending : ok ? g.base.ok : g.base.fail;
      return { glyph, tone, text: `${clean(proof.command, 120)}${sep}${facts.join(sep)}` };
    }
    case "review": {
      const tone: Tone = proof.verdict === "accepted" ? "success" : proof.verdict === "rejected" ? "error" : "warning";
      const glyph = proof.verdict === "accepted" ? g.base.ok : proof.verdict === "rejected" ? g.base.fail : g.retry;
      return { glyph, tone, text: `review ${verdictWord(proof.verdict)} (${clean(proof.reviewer, 40)})${proof.independent ? "" : `${sep}same model, not independent`}` };
    }
    case "file":
      return { glyph: g.base.bullet, tone: "muted", text: `${clean(proof.path, 120)}${proof.note === undefined ? "" : `${sep}${clean(proof.note, 80)}`}` };
    case "note":
      return { glyph: g.base.bullet, tone: "muted", text: `${proof.inferred === true ? "inferred: " : ""}${clean(proof.text, 160)}` };
  }
}

export function renderEvidence(view: EvidenceView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const width = ctx.width;
  const sep = ` ${g.base.sep} `;
  const counts = new Map<CriterionStatusView, number>();
  for (const criterion of view.criteria) counts.set(criterion.status, (counts.get(criterion.status) ?? 0) + 1);
  const tally = (["passed", "failed", "not_run", "unverifiable"] as const).filter((status) => (counts.get(status) ?? 0) > 0).map((status) => `${counts.get(status)} ${STATUS[status].word}`);
  const title = clean(view.title, 60);
  const head = [`${g.base.bullet} Evidence${title === "" ? "" : ` ${g.base.sep} ${title}`}`, `${view.criteria.length} criteri${view.criteria.length === 1 ? "on" : "a"}`, ...tally].join(sep);
  const lines = [t.accent(truncate(head, width))];
  const independent = view.review?.independent === true;
  const badge = independent ? `[${g.base.ok} independently reviewed]` : `[${g.base.warn} not independently reviewed]`;
  lines.push(`  ${independent ? t.success(badge) : t.warning(badge)}`);
  if (view.criteria.length === 0) lines.push(t.muted("  no acceptance criteria were recorded"));
  const textWidth = Math.max(10, width - 4);
  for (const criterion of view.criteria) {
    const status = STATUS[criterion.status];
    const wrapped = wrap(clean(criterion.text, 300), textWidth - displayWidth(status.word) - 3);
    lines.push(`  ${paint(t, status.tone, statusGlyph(criterion.status, ctx))} ${wrapped[0] ?? ""}  ${paint(t, status.tone, status.word)}`);
    for (const more of wrapped.slice(1)) lines.push(`    ${more}`);
    if (criterion.proofs.length === 0) lines.push(t.muted(`    ${g.base.result} no proof recorded`));
    for (const proof of criterion.proofs) {
      const shown = proofLine(proof, ctx);
      lines.push(`    ${t.muted(g.base.result)} ${paint(t, shown.tone, shown.glyph)} ${truncate(shown.text, Math.max(8, width - 8 - displayWidth(g.base.result)))}`);
    }
  }
  const label = (name: string) => t.muted(padEnd(name, 8));
  if (view.review !== undefined) {
    const who = clean(view.review.reviewer, 40);
    const verdict = view.review.verdict === undefined ? "" : `${verdictWord(view.review.verdict)}`;
    const text = [independent ? "independently reviewed" : "not independently reviewed", [verdict, who === "" ? "" : `by ${who}`].filter((part) => part !== "").join(" ")].filter((part) => part !== "").join(sep);
    lines.push(`  ${label("Review")} ${text}`);
  }
  const paths = (view.changedPaths ?? []).map((path) => clean(path, 80));
  if (paths.length > 0) lines.push(`  ${label("Changed")} ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? `, +${paths.length - 3}  /diff` : ""}`);
  if (view.risk !== undefined) lines.push(`  ${label("Risk")} ${t.warning(clean(view.risk, 200))}`);
  if (view.next !== undefined) lines.push(`  ${label("Next")} ${clean(view.next, 200)}`);
  return finish(lines, ctx);
}

function effectText(view: ActionView): string {
  switch (view.effect) {
    case "local":
      return "changes local files";
    case "remote":
      return "changes a remote service";
    case "local+remote":
      return "changes local files and a remote service";
    case "none":
      return "no lasting effect";
  }
}

/** Compact action card (UX-03): what, why, consequence — in a warning-coloured frame. */
export function renderAction(view: ActionView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const box = g.box;
  const width = Math.min(ctx.width, 78);
  const inner = width - 4;
  const title = truncate(clean(view.title, 120), inner - 4);
  const top = `${box.tl}${box.h} ${title} ${box.h.repeat(Math.max(0, width - 5 - displayWidth(title)))}${box.tr}`;
  const rows: { readonly label: string; readonly text: string; readonly tone?: Tone }[] = [
    { label: "What", text: clean(view.what, 400) },
    { label: "Why", text: clean(view.why, 400) },
    { label: "Effect", text: `${clean(view.consequence, 300)} ${g.base.sep} ${effectText(view)} ${g.base.sep} ${view.reversible === true ? "reversible" : view.reversible === false ? "not reversible" : "reversibility unknown"}`, tone: view.reversible === false || view.effect !== "local" ? "warning" : "text" },
  ];
  const paths = (view.paths ?? []).map((path) => clean(path, 80));
  if (paths.length > 0) rows.push({ label: "Paths", text: `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? `, +${paths.length - 3} more` : ""}` });
  if (view.scope !== undefined) rows.push({ label: "Scope", text: clean(view.scope, 200) });
  if (view.warning !== undefined) rows.push({ label: "Note", text: clean(view.warning, 200), tone: "warning" });
  const lines = [t.warning(top)];
  for (const row of rows) {
    const wrapped = wrap(row.text, inner - 7);
    wrapped.forEach((part, index) => {
      const body = `${padEnd(index === 0 ? row.label : "", 6)} ${padEnd(part, inner - 7)}`;
      const painted = index === 0 ? `${t.muted(body.slice(0, 6))}${paint(t, row.tone ?? "text", body.slice(6))}` : paint(t, row.tone ?? "text", body);
      lines.push(`${t.warning(box.v)} ${painted} ${t.warning(box.v)}`);
    });
  }
  lines.push(t.warning(`${box.bl}${box.h.repeat(width - 2)}${box.br}`));
  return finish(lines, ctx);
}

const DECISION: { readonly [D in WhyView["decision"]]: { readonly word: string; readonly tone: Tone } } = {
  allow: { word: "allowed", tone: "success" },
  ask: { word: "needs your approval", tone: "warning" },
  deny: { word: "denied", tone: "error" },
};

/** `/why`: which layer and rule decided, and what would change it. */
export function renderWhy(view: WhyView, ctx: ViewContext): string[] {
  const t = ctx.theme;
  const g = ctx.glyphs;
  const width = ctx.width;
  const decision = DECISION[view.decision];
  const question = view.decision === "deny" ? "Why was this denied?" : view.decision === "ask" ? "Why does this need approval?" : "Why was this allowed?";
  const lines = [`${t.accent(`${g.base.bullet} ${question}`)} ${truncate(clean(view.subject, 200), Math.max(8, width - displayWidth(question) - 4))}`];
  const label = (name: string) => t.muted(padEnd(name, 9));
  lines.push(`  ${label("Decision")} ${paint(t, decision.tone, decision.word)}`);
  if (view.reasons.length === 0) lines.push(`  ${label("Rule")} ${t.muted("no rule recorded")}`);
  view.reasons.forEach((reason, index) => {
    const source = clean(reason.source, 80);
    lines.push(`  ${label(index === 0 ? "Layer" : "")} ${reason.layer}${source === "" ? "" : ` ${g.base.sep} ${source}`}`);
    lines.push(`  ${label("Rule")} ${clean(reason.message, 300)} ${t.muted(`(${clean(reason.code, 64)})`)}`);
  });
  if (view.howToChange.length > 0) {
    const commandWidth = Math.min(28, Math.max(...view.howToChange.map((change) => displayWidth(clean(change.command, 60)))));
    view.howToChange.forEach((change, index) => {
      lines.push(`  ${label(index === 0 ? "Change" : "")} ${t.accent(padEnd(clean(change.command, 60), commandWidth))}  ${t.muted(clean(change.effect, 200))}`);
    });
  } else if (view.decision === "deny") {
    lines.push(`  ${label("Change")} ${t.muted("this rule cannot be changed from the session")}`);
  }
  return finish(lines, ctx);
}
