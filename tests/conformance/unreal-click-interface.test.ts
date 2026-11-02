/**
 * The agent's `click-interface`: the game's own interface clicked during a playtest with Genex's
 * computer control. With it on the agent clicks now; with it off Genex's setting card is asked
 * (`game.computer.control`) and the chat's next turn clicks; a missing or overlong `what` asks nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CLICK_WHAT_MAX_CHARS, clickInterface, clickTask } from "../../src/plugins/unreal/click-interface.ts";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import { ENGINE_ASSIST_TASK_MAX_CHARS, PluginService } from "../../src/shared/plugins.ts";

function context(answer: unknown) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const host = async (method: string, args: unknown) => {
    calls.push({ method, args });
    return answer;
  };
  return { calls, context: { host } as unknown as PluginContext };
}

test("the task names what to click and keeps to the game's view, within the assist's one line", () => {
  const task = clickTask("open the team menu with M and pick Bravo.");
  assert.match(String(task), /^Click the game's interface in Unreal to open the team menu with M and pick Bravo: /);
  assert.match(String(task), /only inside the game's view/);
  assert.ok(String(clickTask("x".repeat(CLICK_WHAT_MAX_CHARS))).length <= ENGINE_ASSIST_TASK_MAX_CHARS);
  for (const what of ["", "   ", "x".repeat(CLICK_WHAT_MAX_CHARS + 1), "two\nlines", 42])
    assert.equal(clickTask(what), null);
});

test("off: the setting's card is asked and the next turn clicks; on: click now; nothing asked without a what", async () => {
  const off = context({ started: true });
  assert.match(await clickInterface({ what: "press Start" }, off.context), /next turn clicks/);
  assert.equal(off.calls[0]?.method, PluginService.GameComputerControl);
  const on = context({ started: false, reason: "already-on" });
  assert.match(await clickInterface({ what: "press Start" }, on.context), /desktop tool now/);
  const declined = context({ started: false, reason: "declined" });
  assert.match(await clickInterface({ what: "press Start" }, declined.context), /said no/);
  const none = context({ started: true });
  assert.match(await clickInterface({}, none.context), /Say what to click/);
  assert.equal(none.calls.length, 0);
});
