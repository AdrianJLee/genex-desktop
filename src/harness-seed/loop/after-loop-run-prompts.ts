/**
 * What the chat's own session reads on each of its turns after a run it led, for as long as that
 * run is the chat's latest (after-loop-run.ts): the build is over, its hands are back, and the run's
 * controls it keeps, spelled for its engine.
 */
import { toolCall } from "./model-roles.ts";
import { RunState } from "./run-events.ts";
import { clip, CLIP_QUOTE } from "./text.ts";
import type { AfterLoopRun } from "./after-loop-run.ts";

/** What the chat is told when the studio did not resume the run the session asked for. */
export const MESSAGE = {
  notResumed: (why: string) => `The build was not resumed: ${why}`,
  /** Why, when Stop came after the reply and before the run was under way again. */
  stoppedFirst: "Stop came before it started again. It stays paused.",
} as const;

/** How the run ended, in a clause: finished and landed or not, or paused and why. */
function closedWords(loopRun: AfterLoopRun): string {
  if (loopRun.state === RunState.Paused)
    return `is PAUSED${loopRun.stoppedBecause ? ` (${clip(loopRun.stoppedBecause, CLIP_QUOTE)})` : ""}`;
  if (loopRun.landed === true) return "finished, and its build is in the game folder";
  if (loopRun.landed === false) return "finished; its build was not put in the game folder";
  return "finished";
}

/** A paused run's change that is not the build itself: the session's own work. */
const PAUSED_OWN_WORK =
  "- Other work they ask for — a fix, an update, a feature that is not that build's goal — you make yourself here, like any change in this chat: the build stays paused.";

/** A paused run's resume on its lead's engine, and what any other change is: the session's own work. */
function workRules(loopRun: AfterLoopRun, engine: string | undefined): string[] {
  if (loopRun.state !== RunState.Paused) return [];
  if (!loopRun.onLeadEngine) return [PAUSED_OWN_WORK];
  return [
    `- This build is paused. When the user asks to go on with that build itself — resume, continue, keep going, run it again, with new guidance for it or none — call ${toolCall(engine, "resume_run")} once, last, with their instruction as text, and edit nothing in that reply: when your reply ends the build resumes where it stopped. Going on, again or "rerun" is this resume.`,
    PAUSED_OWN_WORK,
  ];
}

/**
 * The note that opens each turn of the chat's own session after its run, while that run is the
 * chat's latest: in place of "pick up where you left off" on a resumed session, after the chat so
 * far on a fresh one.
 */
export function afterLoopRunNote(loopRun: AfterLoopRun, engine: string | undefined): string {
  const goal = loopRun.goal ? ` ("${clip(loopRun.goal, CLIP_QUOTE)}")` : "";
  return [
    `THE BUILD IS OVER: run ${loopRun.runId}${goal} ${closedWords(loopRun)}. You are this chat's own session, back in the game folder with your hands: the build no longer runs, and you may read and edit the game here as in any turn of this chat.`,
    "- Answer a question yourself: a question never restarts the build.",
    ...workRules(loopRun, engine),
    loopRun.inPlace ? inPlaceControls(engine) : buildControls(engine),
    "- Speak the user's terms: Live, Builds, the build, your game folder — never integration branch or worktree.",
  ].join("\n");
}

/** The run's controls after a build of its own: its status, and showing or landing what it built. */
function buildControls(engine: string | undefined): string {
  return `- The run's controls: ${toolCall(engine, "run_status")} reads where it stands; ${toolCall(engine, "show_build")} opens a build in Live without changing the game folder (integration: what the run built; live: the game folder as it is), only when the user asks to see or play it: never to show your own edits, which the stage's Reload button offers by itself; ${toolCall(engine, "land_build")} puts what the run built into the game folder — it refuses while the folder has uncommitted edits: say so, and never discard them. After either, say what it answered: open in Live, on the right, or waiting behind Reload while the user watches Live.`;
}

/** The run's control after a Loop that worked in the game folder itself: its status alone, nothing to show or land. */
function inPlaceControls(engine: string | undefined): string {
  return `- The run's control: ${toolCall(engine, "run_status")} reads where it stands. The Loop worked in the game folder itself, so what it made is already there: there is no separate build to show or land.`;
}
