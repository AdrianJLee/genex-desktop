/**
 * The agent's `click-interface`: the game's own interface (a menu drawn in C++ Slate, a button, a
 * scoreboard) clicked during a playtest with Genex's computer control, which the play's own input
 * cannot reach. With computer control on, the desktop tool clicks now (Genex asks once for Unreal
 * Editor on its app card); with it off, Genex asks the person on its card ("Turn on computer
 * control?", `game.computer.control`), then macOS's own grants, and the chat's next turn clicks.
 */
import type { PluginContext, PluginEngineAssistRefusal } from "../../plugin-sdk/index.d.ts";
import { ENGINE_ASSIST_TASK_MAX_CHARS, PluginService } from "../../shared/plugins.ts";

/** What the agent says it will click and check, at most this long, so the task fits the assist's one line. */
export const CLICK_WHAT_MAX_CHARS = 120;

/** What the tool answers the agent: English. */
const MESSAGE = {
  task: (what: string) =>
    `Click the game's interface in Unreal to ${what}: start play with the computer tool, click only inside the game's view with the desktop tool, never Unreal's toolbar or panels.`,
  noWhat: `Say what to click and check in a few words (at most ${CLICK_WHAT_MAX_CHARS} characters), such as "open the team menu with M and pick Bravo".`,
  started:
    "Computer control was off: the person turned it on, and this chat's next turn clicks with it. End your turn now.",
  notStarted: "Genex couldn't hand the clicks to this chat. Read the interface from screenshots instead.",
  refused: {
    unavailable: "This computer has no computer control for Genex: read the interface from screenshots instead.",
    declined: "The person said no to computer control: don't ask again this turn; read the interface from screenshots.",
    "no-chat": "There is no game chat to hand the clicks to.",
    "already-on":
      "Computer control is on: click inside Unreal Editor's game view with the desktop tool now (Genex asks the person once for Unreal Editor), never on Unreal's toolbar or panels.",
  } satisfies Partial<Record<PluginEngineAssistRefusal, string>>,
} as const;

/** The click task's words for `what`, or null when `what` is not one plain short line. */
export function clickTask(what: unknown): string | null {
  const said = typeof what === "string" ? what.trim().replace(/\.$/, "") : "";
  const plain = said.length > 0 && said.length <= CLICK_WHAT_MAX_CHARS && !/[\u0000-\u001f\u007f]/.test(said);
  if (!plain) return null;
  const task = MESSAGE.task(said);
  return task.length <= ENGINE_ASSIST_TASK_MAX_CHARS ? task : null;
}

/** Hands the click task to this game's chat; the agent's words for how it went. */
export async function clickInterface(args: Record<string, unknown>, context: PluginContext): Promise<string> {
  const task = clickTask(args.what);
  if (!task) return MESSAGE.noWhat;
  const answer = await context.host(PluginService.GameComputerControl, { task });
  if (answer.started) return MESSAGE.started;
  const reason = answer.reason;
  const words = reason && reason in MESSAGE.refused ? Reflect.get(MESSAGE.refused, reason) : undefined;
  return typeof words === "string" ? words : MESSAGE.notStarted;
}
