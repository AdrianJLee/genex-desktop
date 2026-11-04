/**
 * The builders' tool sources as sessions see them: plugins and MCP connectors, one revision
 * counter that moves whenever either changes, and which revision each thread last applied. A
 * plan, which cannot call the tools itself, gets them as text.
 */
import type { ConnectionSnapshot } from "../../shared/connections.ts";
import { CustomEvent } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import { mcpScopeCovers, type McpConnectorView } from "../../shared/mcp.ts";
import { McpAuthState } from "../../substrate/mcp/oauth.ts";
import { isAgentTool, type PluginInfo, pluginReach } from "../../shared/plugins.ts";
import type { GameKind } from "../../shared/project-facts.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { planningCapabilities } from "../planning-capabilities.ts";
import type { StudioCore } from "../studio-core.ts";

type ConnectionsCore = Pick<StudioCore, "mcp" | "plugins" | "games" | "append" | "emit">;
type ConnectionSource = ConnectionSnapshot["sources"][number];

/** The tool registry's revision, per-thread applied revisions, and the snapshot built from them. */
export class ConnectionService {
  readonly #core: ConnectionsCore;
  /** Whether a thread has work in flight (a turn, a completion or a delegation). */
  readonly #threadBusy: (threadId: string) => boolean;
  #revision = 0;
  readonly #applied = new Map<string, number>();

  constructor(core: ConnectionsCore, threadBusy: (threadId: string) => boolean) {
    this.#core = core;
    this.#threadBusy = threadBusy;
  }

  /** The current tool registry revision; it moves whenever a plugin or connector changes. */
  get revision(): number {
    return this.#revision;
  }

  /** A plugin or connector changed: move the revision and tell the renderer. */
  changed(): void {
    this.#revision++;
    this.#core.emit(UiEvent.ConnectionsChanged, { revision: this.#revision });
  }

  /** Every tool source the settings and the composer show, with the thread's applied revision. */
  async snapshot(threadId?: string, project?: string | null): Promise<ConnectionSnapshot> {
    const connectors = await this.#core.mcp.list(project ?? null);
    const game = project ? await this.#kindOf(project) : undefined;
    const plugins = await Promise.all(
      this.#core.plugins
        .list()
        .filter((p) => !p.removed)
        .map((p) => this.#pluginSource(p, game)),
    );
    return {
      revision: this.#revision,
      appliedRevision: threadId ? (this.#applied.get(threadId) ?? null) : null,
      active: !!threadId && this.#threadBusy(threadId),
      sources: [
        ...plugins,
        ...connectors.filter((v) => mcpScopeCovers(v.connector.scope, project)).map(connectorSource),
      ],
    };
  }

  /** The builders' plugins, accounts and connectors, for the planning step, which cannot call them itself. */
  async capabilityFacts(
    threadId: string,
    project: string | null | undefined,
  ): Promise<{ revision: number; text: string }> {
    const revision = this.#revision;
    const connections = await this.snapshot(threadId, project);
    const game = project ? (await this.#core.games.list()).find((g) => g.name === project) : undefined;
    const kind: GameKind = game ?? { facts: [] };
    const connectors = await this.#enabledConnectors(project, kind);
    const text = planningCapabilities(revision, this.#core.plugins.shown(), connections, connectors, kind);
    return { revision, text };
  }

  /** A session took the registry at `revision`: remember it for the thread and log it. */
  async recordApplied(threadId: string, engine: string, revision = this.#revision): Promise<void> {
    this.#applied.set(threadId, revision);
    await this.#core.append(
      [{ type: EventKind.Custom, event_type: CustomEvent.ToolRegistryApplied, payload: { revision, engine } }],
      threadId,
    );
    this.#core.emit(UiEvent.ConnectionsApplied, { threadId, revision });
  }

  /** What a game's folder holds; a game whose facts can't be read has no kind yet. */
  async #kindOf(project: string): Promise<GameKind> {
    return this.#core.games.kindOf(project).catch(() => ({ facts: [] }));
  }

  /** The enabled connectors that reach this game, with the tool names a plan may name. */
  async #enabledConnectors(project: string | null | undefined, game: GameKind) {
    const views = await this.#core.mcp.list(project ?? null);
    return views
      .filter((v) => v.connector.enabled && mcpScopeCovers(v.connector.scope, project))
      .filter((v) => this.#core.mcp.reaches(v.connector.id, game.facts, game.holds))
      .map((v) => ({
        id: v.connector.id,
        name: v.connector.name,
        health: v.health,
        tools: this.#core.mcp.planningToolNames(v.connector.id, project ?? null),
      }));
  }

  /** One plugin as a tool source; with a game, its tools are those that reach that game. */
  async #pluginSource(p: PluginInfo, game: GameKind | undefined): Promise<ConnectionSource> {
    // The tools agents get: one only the harness calls is no tool of theirs.
    const agentTools = game ? pluginReach(p.manifest, game).tools : p.manifest.tools.filter(isAgentTool);
    return {
      id: p.manifest.id,
      name: p.manifest.name,
      kind: "plugin",
      enabled: p.enabled,
      health: p.health,
      tools: p.enabled ? agentTools.length : 0,
      pending: !!p.pendingVersion,
      reason: p.error,
      account: await this.#core.plugins.accountState(p.manifest.id),
    };
  }
}

function connectorSource(v: McpConnectorView): ConnectionSource {
  const authorizing = v.authentication?.state === McpAuthState.Authorizing;
  return {
    id: v.connector.id,
    name: v.connector.name,
    kind: "mcp",
    enabled: v.connector.enabled,
    health: authorizing ? McpAuthState.Authorizing : v.health,
    tools: v.toolCount,
    pending: v.pending,
    reason: v.authentication?.error ?? v.error,
  };
}
