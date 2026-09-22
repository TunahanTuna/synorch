import type { ModelMessage, SystemBlock, ToolDescriptor } from "../contracts/index.ts";

/**
 * A provider-neutral token estimate (about four characters per token). It only has to be stable
 * and conservative enough to budget a context; providers report the real numbers afterwards.
 */

export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

export function messageTokens(message: ModelMessage): number {
  let total = 4;
  for (const part of message.content) {
    switch (part.type) {
      case "text":
      case "thinking":
        total += estimateTokens(part.text);
        break;
      case "tool_call":
        total += estimateTokens(part.name) + estimateTokens(JSON.stringify(part.arguments));
        break;
      case "tool_result":
        total += estimateTokens(part.text);
        break;
      case "blob":
        total += 16;
        break;
    }
  }
  return total;
}

export function blockTokens(block: Pick<SystemBlock, "text">): number {
  return estimateTokens(block.text) + 4;
}

export function toolTokens(tools: readonly ToolDescriptor[]): number {
  return tools.reduce((sum, tool) => sum + estimateTokens(tool.name + tool.description + JSON.stringify(tool.input_schema)), 0);
}
