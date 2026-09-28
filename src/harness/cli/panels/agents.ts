import type { PanelAction, PanelBlock, PanelItem, PanelPage } from "../../contracts/index.ts";
import { groupedViews } from "../../contracts/index.ts";
import type { ExtensionSlashHost } from "../extensions-command.ts";
import { personaBaseRole, personaModelTier, type PluginAgent } from "../extensions/index.ts";
import { openFile, plural } from "./common.ts";

/**
 * `/agents` as a panel: the worker personas of enabled plugins by origin (tabs), each drillable to
 * its detail (file, base role and tools, model tier, instructions). `o` opens the agent's file.
 */

function agentActions(host: ExtensionSlashHost, agent: PluginAgent): PanelAction[] {
  return [{ key: "o", label: "open file", run: async () => ({ message: await openFile(agent.file, host.env) }) }];
}

function tierText(agent: PluginAgent): string {
  const tier = personaModelTier(agent.model);
  return `${agent.model ?? "inherit"}${tier === undefined ? " (the orchestrator's tier)" : ` → tier ${tier} (your routes for that tier decide)`}`;
}

/** One agent in detail. */
export function agentPage(host: ExtensionSlashHost, agent: PluginAgent): PanelPage {
  const blocks: PanelBlock[] = [
    {
      kind: "fields",
      rows: [
        { label: "plugin", value: `${agent.plugin} (${agent.origin})` },
        { label: "file", value: agent.file },
        { label: "description", value: agent.description === "" ? "(none)" : agent.description },
        { label: "base role", value: `${personaBaseRole(agent)}${agent.tools.length === 0 ? " (all tools)" : ""}` },
        { label: "tools", value: agent.tools.length === 0 ? "all (inherits every tool)" : agent.tools.join(", ") },
        { label: "model", value: tierText(agent) },
      ],
    },
    { kind: "heading", text: "Instructions" },
    { kind: "markdown", text: agent.body.trim() === "" ? "_(empty)_" : agent.body },
  ];
  return {
    title: agent.id,
    crumb: agent.name,
    subtitle: `${agent.origin} plugin ${agent.plugin} ${host.sep} ${personaBaseRole(agent)}`,
    views: [{ kind: "document", label: "Overview", blocks }],
    actions: agentActions(host, agent),
    reload: () => {
      const fresh = host.extensions.personas.find(agent.id);
      return fresh === undefined ? { title: agent.id, crumb: agent.name, views: [{ kind: "document", label: "Overview", blocks: [{ kind: "text", text: "no longer available", tone: "muted" }] }] } : agentPage(host, fresh);
    },
  };
}

/** The `/agents` root page. */
export function agentsPanel(host: ExtensionSlashHost): PanelPage {
  const agents = host.extensions.personas.list();
  const item = (agent: PluginAgent): PanelItem => {
    const tier = personaModelTier(agent.model);
    return {
      id: agent.id,
      label: agent.id,
      meta: personaBaseRole(agent),
      badges: [...(tier === undefined ? [] : [{ label: tier, tone: "muted" as const }]), { label: `${agent.origin === "claude" ? "claude" : "synorch"}:${agent.plugin}`, tone: "muted" as const }],
      description: agent.description,
      search: agent.tools.join(" "),
      open: () => agentPage(host, agent),
      actions: agentActions(host, agent),
    };
  };
  return {
    title: "Agents",
    subtitle: `${plural(agents.length, "agent")} ${host.sep} worker personas the orchestrator may assign to a task`,
    views: groupedViews(agents, item, (agent) => agent.origin, [["synorch", "Synorch"], ["claude", "Claude"]], { empty: "No plugin agents yet: a plugin's agents/*.md become worker personas" }),
    reload: () => agentsPanel(host),
  };
}
