#!/usr/bin/env python3
"""Distill Claude Code session transcripts into a resumable digest.

Reads ~/.claude/projects/<encoded-cwd>/*.jsonl without loading transcripts into
the model's context. Stdlib only.

  python extract_session.py --list
  python extract_session.py --session latest
  python extract_session.py --session <session-id> --json
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, OrderedDict

EDIT_TOOLS = ("Edit", "Write", "NotebookEdit", "MultiEdit")
SHELL_TOOLS = ("Bash", "PowerShell")
RESEARCH_TOOLS = ("WebSearch", "WebFetch")
INTERRUPT_MARK = "[Request interrupted by user"
NOISE_PREFIXES = ("<local-command", "<command-name>", "<command-message>")


def projects_root():
    return os.path.join(os.path.expanduser("~"), ".claude", "projects")


def encode_cwd(path):
    return re.sub(r"[^a-zA-Z0-9]", "-", path)


def resolve_project_dir(cwd):
    root = projects_root()
    direct = os.path.join(root, encode_cwd(os.path.abspath(cwd)))
    if os.path.isdir(direct):
        return direct
    target = os.path.abspath(cwd).rstrip("\\/").lower()
    if not os.path.isdir(root):
        return None
    for name in os.listdir(root):
        cand = os.path.join(root, name)
        if not os.path.isdir(cand):
            continue
        for f in transcript_files(cand)[:1]:
            for rec in read_records(f, limit=40):
                rc = rec.get("cwd")
                if rc and rc.rstrip("\\/").lower() == target:
                    return cand
    return None


def transcript_files(project_dir):
    """All transcripts, newest first."""
    files = [
        os.path.join(project_dir, n)
        for n in os.listdir(project_dir)
        if n.endswith(".jsonl")
    ]
    return sorted(files, key=os.path.getmtime, reverse=True)


def seconds_idle(path):
    import time

    return time.time() - os.path.getmtime(path)


def read_records(path, limit=None):
    out = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
            if limit and len(out) >= limit:
                break
    return out


def blocks(rec):
    msg = rec.get("message")
    if not isinstance(msg, dict):
        return []
    content = msg.get("content")
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def text_of(rec):
    msg = rec.get("message")
    if not isinstance(msg, dict):
        return ""
    content = msg.get("content")
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in blocks(rec) if b.get("type") == "text")


def is_real_prompt(rec):
    if rec.get("type") != "user" or rec.get("isMeta") or rec.get("isSidechain"):
        return False
    if rec.get("promptSource") not in ("typed", "queued", None):
        return False
    txt = text_of(rec).strip()
    if not txt or txt.startswith(NOISE_PREFIXES):
        return False
    return rec.get("promptSource") in ("typed", "queued")


def squeeze(text, limit):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def rel(path, cwd):
    if not path:
        return path
    norm = path.replace("/", os.sep).replace("\\", os.sep)
    base = os.path.abspath(cwd).replace("/", os.sep).replace("\\", os.sep)
    if norm.lower().startswith(base.lower()):
        norm = norm[len(base) :].lstrip("\\/")
    return norm.replace("\\", "/")


def summarize(path, cwd, prompt_chars=400, cap=25):
    recs = read_records(path)
    stamps = [r["timestamp"] for r in recs if r.get("timestamp")]
    title = next(
        (r["aiTitle"] for r in reversed(recs) if r.get("type") == "ai-title" and r.get("aiTitle")),
        None,
    )
    session_cwd = next((r["cwd"] for r in recs if r.get("cwd")), cwd)
    branches = OrderedDict(
        (r["gitBranch"], None) for r in recs if r.get("gitBranch")
    )

    prompts, edits, shell, research, skills, agents = [], Counter(), [], [], [], []
    errors, denials, interrupts = [], [], 0
    last_assistant = ""
    tool_names = {}

    def tool_of(rec):
        """Resolve which tool a tool_result block belongs to."""
        for blk in blocks(rec):
            tid = blk.get("tool_use_id")
            if tid and tid in tool_names:
                return tool_names[tid]
        return None

    for rec in recs:
        if is_real_prompt(rec):
            txt = text_of(rec)
            if INTERRUPT_MARK in txt:
                interrupts += 1
            prompts.append(squeeze(txt, prompt_chars))
        if rec.get("toolDenialKind"):
            denials.append(
                "%s (%s)" % (tool_of(rec) or "unknown tool", rec["toolDenialKind"])
            )
        if rec.get("interruptedMessageId"):
            interrupts += 1
        if rec.get("type") == "file-history-delta" and rec.get("trackingPath"):
            edits[rel(rec["trackingPath"], session_cwd)] += 0

        msg = rec.get("message") or {}
        role = msg.get("role") if isinstance(msg, dict) else None
        if role == "assistant" and not rec.get("isSidechain"):
            t = text_of(rec).strip()
            if t:
                last_assistant = t
        for blk in blocks(rec):
            kind = blk.get("type")
            if kind == "tool_result" and blk.get("is_error"):
                body = blk.get("content")
                if isinstance(body, list):
                    body = " ".join(
                        b.get("text", "") for b in body if isinstance(b, dict)
                    )
                who = tool_names.get(blk.get("tool_use_id")) or "tool"
                errors.append("%s: %s" % (who, squeeze(str(body), 180)))
            if kind != "tool_use":
                continue
            name, inp = blk.get("name"), blk.get("input") or {}
            if blk.get("id"):
                tool_names[blk["id"]] = name
            if name in EDIT_TOOLS:
                fp = inp.get("file_path") or inp.get("notebook_path")
                if fp:
                    edits[rel(fp, session_cwd)] += 1
            elif name in SHELL_TOOLS:
                cmd = squeeze(str(inp.get("command", "")), 160)
                if cmd:
                    shell.append(cmd)
            elif name in RESEARCH_TOOLS:
                research.append(
                    "%s: %s" % (name, squeeze(str(inp.get("query") or inp.get("url") or ""), 160))
                )
            elif name == "Skill":
                if inp.get("skill"):
                    skills.append(inp["skill"])
            elif name == "Agent":
                agents.append(squeeze(str(inp.get("description") or ""), 90))

    return {
        "session_id": os.path.basename(path)[:-6],
        "file": path,
        "title": title,
        "cwd": session_cwd,
        "started": stamps[0] if stamps else None,
        "ended": stamps[-1] if stamps else None,
        "branches": list(branches),
        "prompts": prompts,
        "files": [
            {"path": p, "edits": n} for p, n in sorted(edits.items(), key=lambda kv: -kv[1])
        ],
        "commands": dedupe(shell)[:cap],
        "research": dedupe(research)[:cap],
        "skills": dedupe(skills),
        "agents": dedupe(agents)[:cap],
        "errors": dedupe(errors)[:cap],
        "denials": denials,
        "interrupts": interrupts,
        "last_assistant": squeeze(last_assistant, 700),
        "record_count": len(recs),
    }


def dedupe(items):
    return list(OrderedDict((i, None) for i in items))


def brief(path, cwd):
    """Cheap listing entry."""
    d = summarize(path, cwd, prompt_chars=110, cap=1)
    return {
        "session_id": d["session_id"],
        "title": d["title"],
        "started": d["started"],
        "ended": d["ended"],
        "prompts": len(d["prompts"]),
        "files": len(d["files"]),
        "first_prompt": d["prompts"][0] if d["prompts"] else "",
    }


def render(d):
    L = ["# Session digest — %s" % (d["title"] or d["session_id"])]
    L.append("")
    L.append("- session: `%s`" % d["session_id"])
    L.append("- window: %s → %s" % (d["started"], d["ended"]))
    L.append("- cwd: `%s`" % d["cwd"])
    if d["branches"]:
        L.append("- branch(es): %s" % ", ".join("`%s`" % b for b in d["branches"]))
    L.append("- records: %d" % d["record_count"])

    def block(head, items, fmt=lambda x: "- %s" % x):
        if not items:
            return
        L.append("")
        L.append("## %s" % head)
        L.extend(fmt(i) for i in items)

    block("User prompts (verbatim intent, in order)", list(enumerate(d["prompts"], 1)),
          lambda t: "%d. %s" % t)
    block("Files touched", d["files"],
          lambda f: "- `%s`%s" % (f["path"], "" if not f["edits"] else "  (%d edit calls)" % f["edits"]))
    block("Research", d["research"])
    block("Skills loaded", d["skills"])
    block("Subagents", d["agents"])
    block("Commands run", d["commands"])
    block("Tool errors (dead-end candidates)", d["errors"])
    if d["denials"] or d["interrupts"]:
        L.append("")
        L.append("## Friction signals")
        if d["denials"]:
            L.append("- denied tool calls: %s" % ", ".join(d["denials"]))
        if d["interrupts"]:
            L.append("- user interruptions: %d" % d["interrupts"])
    if d["last_assistant"]:
        L.append("")
        L.append("## Final assistant state")
        L.append(d["last_assistant"])
    return "\n".join(L)


def force_utf8():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def main():
    force_utf8()
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--session", help="'latest' or a session id")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--prompt-chars", type=int, default=400)
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--exclude-session",
        action="append",
        default=[],
        help="session id to leave out of 'latest' selection (repeatable) — use for the live session",
    )
    ap.add_argument(
        "--active-window",
        type=int,
        default=60,
        help="seconds of idleness below which a transcript is flagged as possibly live (default 60)",
    )
    ap.add_argument(
        "--all",
        action="store_true",
        help="keep sessions with no typed prompt (headless -p runs, aborted starts)",
    )
    args = ap.parse_args()

    pdir = resolve_project_dir(args.cwd)
    if not pdir:
        print("No transcript directory for cwd: %s" % args.cwd, file=sys.stderr)
        print("Looked under: %s" % projects_root(), file=sys.stderr)
        return 2
    files = transcript_files(pdir)
    if not files:
        print("No transcripts in %s" % pdir, file=sys.stderr)
        return 2

    # An explicit id always wins: no emptiness, liveness or limit filtering.
    if args.session and args.session != "latest":
        target = next(
            (f for f in files if os.path.basename(f).startswith(args.session)), None
        )
        if not target:
            print("Session not found: %s" % args.session, file=sys.stderr)
            print("Known ids: %s" % ", ".join(os.path.basename(f)[:8] for f in files[:10]), file=sys.stderr)
            return 2
        d = summarize(target, args.cwd, prompt_chars=args.prompt_chars)
        print(json.dumps(d, indent=2, ensure_ascii=False) if args.json else render(d))
        return 0

    rows, kept, skipped = [], [], 0
    for f in files:
        r = brief(f, args.cwd)
        if not args.all and r["prompts"] == 0:
            skipped += 1
            continue
        idle = seconds_idle(f)
        r["idle_seconds"] = int(idle)
        r["maybe_live"] = idle < args.active_window
        r["excluded"] = any(r["session_id"].startswith(x) for x in args.exclude_session)
        rows.append(r)
        kept.append(f)
        if len(rows) >= args.limit:
            break
    if not kept:
        print("No session with a typed prompt in %s (--all to inspect them)" % pdir, file=sys.stderr)
        return 2

    eligible = [
        (r, f) for r, f in zip(rows, kept) if not r["excluded"] and not r["maybe_live"]
    ] or [(r, f) for r, f in zip(rows, kept) if not r["excluded"]]

    if args.list or not args.session:
        if args.json:
            print(json.dumps(
                {"project_dir": pdir, "sessions": rows, "skipped_empty": skipped,
                 "suggested": eligible[0][0]["session_id"] if eligible else None},
                indent=2, ensure_ascii=False))
        else:
            print("# Recent sessions — %s\n" % pdir)
            for i, r in enumerate(rows, 1):
                flags = []
                if r["maybe_live"]:
                    flags.append("POSSIBLY THE SESSION YOU ARE IN — written %ds ago" % r["idle_seconds"])
                if r["excluded"]:
                    flags.append("excluded")
                print("%d. **%s**%s" % (i, r["title"] or "(untitled)",
                                        "  ⟨%s⟩" % "; ".join(flags) if flags else ""))
                print("   id `%s` | %s → %s" % (r["session_id"], r["started"], r["ended"]))
                print("   %d prompts, %d files | opened with: %s" % (r["prompts"], r["files"], r["first_prompt"]))
            if skipped:
                print("\n_(%d session(s) with no typed prompt hidden — headless or aborted runs; --all to show)_" % skipped)
            if eligible:
                print("\nSuggested: `%s`. Confirm it is not this conversation before summarizing." % eligible[0][0]["session_id"])
        return 0

    if not eligible:
        print("Every candidate is excluded or possibly live; pass --session <id> explicitly.", file=sys.stderr)
        return 2
    target = eligible[0][1]
    d = summarize(target, args.cwd, prompt_chars=args.prompt_chars)
    print(json.dumps(d, indent=2, ensure_ascii=False) if args.json else render(d))
    return 0


if __name__ == "__main__":
    sys.exit(main())

