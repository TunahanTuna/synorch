export interface SseMessage {
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Incremental Server-Sent Events decoder (WHATWG event-stream rules): LF, CR or CRLF line ends,
 * multi-line `data`, `:` comments ignored, a blank line dispatches. Bytes are decoded as UTF-8
 * with multi-byte sequences split across chunks handled by the streaming decoder.
 */
export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  let pendingCarriageReturn = false;

  function* takeLines(final: boolean): Generator<SseMessage> {
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character !== "\n" && character !== "\r") continue;
      const line = buffer.slice(start, index);
      if (character === "\r" && buffer[index + 1] === "\n") index += 1;
      else if (character === "\r" && index === buffer.length - 1 && !final) pendingCarriageReturn = true;
      start = index + 1;
      const message = acceptLine(line);
      if (message !== undefined) yield message;
    }
    buffer = buffer.slice(start);
  }

  function acceptLine(line: string): SseMessage | undefined {
    if (line === "") {
      if (data.length === 0) {
        event = undefined;
        return undefined;
      }
      const message = { event, data: data.join("\n") };
      event = undefined;
      data = [];
      return message;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return undefined;
  }

  for await (const chunk of body) {
    let text = decoder.decode(chunk, { stream: true });
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    buffer += text;
    yield* takeLines(false);
  }
  buffer += decoder.decode();
  if (buffer.length > 0) buffer += "\n";
  yield* takeLines(true);
  const trailing = acceptLine("");
  if (trailing !== undefined) yield trailing;
}

/** Parses one SSE `data` payload as JSON; `undefined` when it is not a JSON object. */
export function parseSseJson(data: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
