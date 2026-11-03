/**
 * Capability handshake: what the harness can dispatch is a fact about the loaded copy (the agent's
 * own code), not about the app, so the loaded self declares its capabilities in the ready message
 * and the host checks one before it hands that work over.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { HarnessCapability } from "../../src/shared/protocol.ts";
import { startRig, type Rig } from "../helpers/studio-rig.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

describe("loop capability handshake", () => {
  it("the shipped seed claims its dispatch features through the ready message", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const claimed = [
      HarnessCapability.Autopilot,
      HarnessCapability.RunStart,
      HarnessCapability.RunStop,
      HarnessCapability.Compact,
    ];
    // Flipped (Loop phase 5): the seed has no SkillOpt, so it claims no skillopt.
    for (const name of claimed) {
      assert.equal(rig.core.host.hasCapability(name), true, `the seed must claim ${name}`);
    }
  });
});
