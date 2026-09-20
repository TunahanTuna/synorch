import { parse, stringify } from "yaml";

export function parseYaml(content: string): unknown {
  return parse(content);
}

export function stringifyYaml(value: unknown): string {
  return stringify(value, {
    indent: 2,
    lineWidth: 0,
  });
}
