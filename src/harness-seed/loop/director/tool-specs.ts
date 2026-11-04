/**
 * A Loop lead's run tools as its engine sees them: their names (`DirectorTool`), the specs the lead's
 * tool list (open/tool-specs.ts) shares, and the registry the studio's `director_tool` dispatch
 * forwards a call through to the live session's handler (open/tools.ts). The worker tools are
 * Genex's one worker model (`loop/workers/specs.ts`).
 */
import { WorkerTool } from "../workers/contract.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LiveToolSpec } from "../../types/host-api.d.ts";

/**
 * Every run tool a lead's session calls, by the name its engine sends. The studio forwards them as
 * they are, and the feed and the tests read them: never rename a value.
 */
export const DirectorTool = {
  RunStatus: "run_status",
  WorkerStart: WorkerTool.Start,
  WorkerStatus: WorkerTool.Status,
  WorkerSteer: WorkerTool.Steer,
  WorkerStop: WorkerTool.Stop,
  Wait: WorkerTool.Wait,
  Judge: "judge",
  Note: "note",
  /** The user asked to finish: the lead records it, quoting them (wrap-up.ts). */
  WrapUp: "wrap_up",
  Finish: "finish",
} as const;
export type DirectorTool = (typeof DirectorTool)[keyof typeof DirectorTool];

/** `note` as the lead's engine sees it. */
export const NOTE_SPEC: LiveToolSpec = {
  name: DirectorTool.Note,
  description: "Leave a card in the run's feed: what you decided and why. The user reads these.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The card; shas, worker ids and file paths are fine." },
      plain: {
        type: "string",
        description: "The same in one sentence for someone who has never seen a terminal: no shas, ids or error text.",
      },
    },
    required: ["text"],
  },
};

/** `wrap_up` as the lead's engine sees it: the one place the rule for a person's ask to stop or finish is stated. */
export const WRAP_UP_SPEC: LiveToolSpec = {
  name: DirectorTool.WrapUp,
  description:
    "The person asked to stop or finish the build: call this first, quoting their words. No worker starts after it; the wrap-up starts when this turn ends. To stop at once, call finish after it.",
  parameters: {
    type: "object",
    properties: {
      user_asked: { type: "string", description: "Their words asking to finish, quoted exactly." },
      next_goal: {
        type: "string",
        description: "Asked to start a new Loop after: what it builds (it starts once this run closes).",
      },
    },
    required: ["user_asked"],
  },
};

/** runId → the tool handler of the live lead session (the dispatch `director_tool` lands here). */
export const directors = new Map<string, (name: string, args: AnyRecord) => Promise<unknown>>();

/** The studio forwards a lead's tool call; a run without a lead answers with a sentence. */
export async function directorTool({
  runId,
  name,
  args,
}: {
  runId: string;
  name: unknown;
  args: unknown;
}): Promise<unknown> {
  const handler = directors.get(runId);
  if (!handler) return `no lead session for run ${runId} — the run is not active in this harness`;
  return handler(String(name ?? ""), args && typeof args === "object" ? (args as AnyRecord) : {});
}
