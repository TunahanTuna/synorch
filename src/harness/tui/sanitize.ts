/**
 * Model and tool output is untrusted terminal input (ADR-04): escape sequences such as OSC 52
 * clipboard writes, window titles or `CSI 2J` must never reach the terminal. Only printable text,
 * tabs and LF survive; a carriage return keeps the last overwrite of a line, like a progress bar.
 */

const STRING_SEQUENCE = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g;
const CSI_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?/g;
const SHORT_ESCAPE = /\x1b[ -/]*[0-~]?/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function sanitizeTerminalText(text: string): string {
  const withoutSequences = text
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(SHORT_ESCAPE, "")
    .replace(/\r\n/g, "\n");
  return withoutSequences
    .split("\n")
    .map((line) => {
      const overwrite = line.lastIndexOf("\r", line.length - 2);
      const visible = overwrite === -1 ? line : line.slice(overwrite + 1);
      return visible.replace(CONTROL, "");
    })
    .join("\n");
}

/** One-line form for status lines, card headers and approval summaries. */
export function sanitizeInline(text: string, maxLength = 500): string {
  const flat = sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
  const characters = [...flat];
  return characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join("")}…` : flat;
}
