/**
 * K4.1 `web_fetch`: a small, dependency-free HTML → markdown converter. It is not a browser: it
 * drops script/style/navigation chrome, prefers the page's `<main>`/`<article>` when present, keeps
 * headings, paragraphs, lists, links, code, quotes and simple tables, and decodes entities. Pages
 * built by JavaScript come back (nearly) empty, and the tool says so.
 */

const DROPPED_BLOCKS = ["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "head", "form", "select", "button"];
const CHROME_BLOCKS = ["nav", "footer", "aside"];
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "area", "base", "col", "embed", "param", "track"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®",
  trade: "™", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", times: "×",
  divide: "÷", euro: "€", pound: "£", yen: "¥", cent: "¢", deg: "°", para: "¶", sect: "§", rarr: "→", larr: "←", uarr: "↑", darr: "↓",
  check: "✓", shy: "", zwj: "", zwnj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return codePoint(Number.parseInt(body.slice(2), 16)) ?? whole;
    if (body.startsWith("#")) return codePoint(Number.parseInt(body.slice(1), 10)) ?? whole;
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function codePoint(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return undefined;
  try {
    return String.fromCodePoint(value);
  } catch {
    return undefined;
  }
}

export interface HtmlDocument {
  readonly title: string | undefined;
  readonly markdown: string;
}

interface Token {
  readonly kind: "open" | "close" | "text";
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
}

function attributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (name === undefined) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\s*\/?>/g;
  let last = 0;
  for (const match of html.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: "text", name: "", attrs: {}, text: html.slice(last, index) });
    last = index + match[0].length;
    const name = match[1]?.toLowerCase();
    if (name === undefined) continue;
    const closing = match[0].startsWith("</");
    tokens.push({ kind: closing ? "close" : "open", name, attrs: closing ? {} : attributes(match[2] ?? ""), text: "" });
  }
  if (last < html.length) tokens.push({ kind: "text", name: "", attrs: {}, text: html.slice(last) });
  return tokens;
}

/** Removes `<name>…</name>` blocks (raw-text elements are matched without parsing their content). */
function stripBlocks(html: string, names: readonly string[]): string {
  let out = html;
  for (const name of names) out = out.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, "gi"), " ");
  return out;
}

/** The inner HTML of the first `<tag>` element, balanced by a nesting count. */
function innerOf(html: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(html);
  if (open === null) return undefined;
  const start = open.index + open[0].length;
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = start;
  let depth = 1;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return html.slice(start);
}

function resolveHref(href: string, base: string | undefined): string | undefined {
  const trimmed = href.trim();
  if (trimmed === "" || /^(javascript|data|vbscript):/i.test(trimmed)) return undefined;
  if (trimmed.startsWith("#")) return undefined;
  try {
    return base === undefined ? new URL(trimmed).toString() : new URL(trimmed, base).toString();
  } catch {
    return undefined;
  }
}

/** Converts an HTML page to readable markdown; `baseUrl` resolves relative links. */
export function htmlToMarkdown(html: string, baseUrl?: string): HtmlDocument {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch?.[1] === undefined ? undefined : collapse(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ""))).trim() || undefined;
  let body = stripBlocks(html, DROPPED_BLOCKS);
  const main = innerOf(body, "main") ?? innerOf(body, "article");
  body = main ?? innerOf(body, "body") ?? body;
  if (main === undefined) body = stripBlocks(body, [...CHROME_BLOCKS, "header"]);

  const out: string[] = [];
  const lists: { ordered: boolean; count: number }[] = [];
  const links: { href: string | undefined; start: number }[] = [];
  let pre = 0;
  let inTable = false;
  let rowCells: string[] | undefined;
  let cellStart = -1;
  let headerRowDone = false;
  /** The last two characters written (linear: never joins the whole output). */
  const tail = (): string => {
    let result = "";
    for (let index = out.length - 1; index >= 0 && result.length < 2; index -= 1) result = (out[index] ?? "") + result;
    return result.slice(-2);
  };
  const block = (): void => {
    const current = tail();
    if (current === "" || current === "\n\n") return;
    out.push(current.endsWith("\n") ? "\n" : "\n\n");
  };
  const line = (): void => {
    const current = tail();
    if (current !== "" && !current.endsWith("\n")) out.push("\n");
  };

  for (const token of tokenize(body)) {
    if (token.kind === "text") {
      const decoded = decodeEntities(token.text);
      if (pre > 0) out.push(decoded);
      else {
        const collapsed = collapse(decoded);
        const current = tail();
        if (collapsed === " " && (current === "" || /[\s(\[]$/.test(current))) continue;
        out.push(/\s$/.test(current) || current === "" ? collapsed.replace(/^ /, "") : collapsed);
      }
      continue;
    }
    const name = token.name;
    const opening = token.kind === "open";
    switch (name) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        block();
        if (opening) out.push(`${"#".repeat(Number(name[1]))} `);
        break;
      case "p": case "div": case "section": case "header": case "figure": case "figcaption": case "dl": case "details": case "summary":
        block();
        break;
      case "br":
        out.push("\n");
        break;
      case "hr":
        block();
        out.push("---");
        block();
        break;
      case "ul": case "ol":
        if (opening) {
          line();
          lists.push({ ordered: name === "ol", count: 0 });
        } else {
          lists.pop();
          block();
        }
        break;
      case "li":
        if (opening) {
          line();
          const list = lists.at(-1);
          const depth = Math.max(0, lists.length - 1);
          if (list !== undefined) list.count += 1;
          out.push(`${"  ".repeat(depth)}${list?.ordered === true ? `${list.count}.` : "-"} `);
        } else line();
        break;
      case "dt":
        line();
        break;
      case "dd":
        line();
        if (opening) out.push("  ");
        break;
      case "blockquote":
        block();
        if (opening) out.push("> ");
        break;
      case "pre":
        if (opening) {
          block();
          out.push("```\n");
          pre += 1;
        } else {
          pre = Math.max(0, pre - 1);
          line();
          out.push("```");
          block();
        }
        break;
      case "code": case "kbd": case "samp": case "tt":
        if (pre === 0) out.push("`");
        break;
      case "strong": case "b":
        out.push("**");
        break;
      case "em": case "i":
        out.push("_");
        break;
      case "a":
        if (opening) links.push({ href: resolveHref(token.attrs.href ?? "", baseUrl), start: out.length });
        else {
          const link = links.pop();
          if (link?.href !== undefined && link.start <= out.length) {
            const label = collapse(out.splice(link.start).join("")).trim();
            out.push(label === "" ? `<${link.href}>` : `[${label}](${link.href})`);
          }
        }
        break;
      case "img": {
        const alt = collapse(token.attrs.alt ?? "").trim();
        if (alt !== "") out.push(`[image: ${alt}]`);
        break;
      }
      case "table":
        block();
        inTable = opening;
        headerRowDone = false;
        if (!opening) block();
        break;
      case "tr":
        if (!inTable) break;
        if (opening) rowCells = [];
        else if (rowCells !== undefined) {
          line();
          out.push(`| ${rowCells.join(" | ")} |`);
          if (!headerRowDone) {
            out.push(`\n|${rowCells.map(() => " --- ").join("|")}|`);
            headerRowDone = true;
          }
          out.push("\n");
          rowCells = undefined;
        }
        break;
      case "td": case "th":
        if (rowCells === undefined) break;
        if (opening) cellStart = out.length;
        else if (cellStart >= 0 && cellStart <= out.length) {
          rowCells.push(collapse(out.splice(cellStart).join("")).trim().replaceAll("|", "\\|"));
          cellStart = -1;
        }
        break;
      default:
        if (!VOID.has(name) && opening && /^(address|center|main|article|nav|aside|footer|fieldset|legend)$/.test(name)) block();
        break;
    }
  }
  const markdown = out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\*\*\s*\*\*/g, "")
    .trim();
  return { title, markdown };
}

function collapse(text: string): string {
  return text.replace(/[\s ]+/g, " ");
}
