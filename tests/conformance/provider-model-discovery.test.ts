import assert from "node:assert/strict";
import { test } from "node:test";
import { withClaudeModelCapabilities } from "../../src/substrate/engines/claude-telemetry.ts";
import { resolveRoles } from "../../src/shared/model-roles.ts";
import { toChoices, resolveChoice } from "../../src/renderer/model-choices.ts";
import { EngineKind, EngineStatusCode, type EngineDescriptor } from "../../src/shared/engine-descriptor.ts";
import { EngineId } from "../../src/shared/providers.ts";

const model = (id: string, label = id) => ({
  id,
  label,
  contextWindow: 0,
  maxTokens: 64000,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: true,
});
const engine: EngineDescriptor = {
  id: EngineId.ClaudeCode,
  label: "Claude Code",
  kind: EngineKind.Delegated,
  status: { code: EngineStatusCode.Ready, detail: "" },
  models: [
    model("default"),
    { ...model("sonnet"), efforts: ["low", "high"], defaultEffort: "low" },
    model("claude-sonnet-5-5"),
  ],
  defaultModel: null,
};

test("provider labels replace stale names without changing alias identity", () => {
  const rows = withClaudeModelCapabilities(
    [model("sonnet", "Sonnet 5")],
    [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" }],
  );
  assert.equal(rows[0]?.label, "Sonnet 5.5");
  assert.equal(rows[0]?.id, "sonnet");
});
test("provider default remains a default and respects advertised effort", () => {
  const choices = toChoices([engine]);
  assert.equal(resolveChoice(choices, "claude-code::default")?.key, "claude-code::default");
  assert.equal(resolveChoice(choices, "claude-code::sonnet")?.defaultEffort, "low");
});
test("unset roles delegate model selection to the CLI", () => {
  assert.deepEqual(resolveRoles(EngineId.ClaudeCode, undefined), {
    planner: undefined,
    builder: undefined,
    judge: undefined,
  });
});

import { composerSendOptions, resolveComposerModel } from "../../src/renderer/chat/use-composer-model.ts";
test("provider defaults reach the normal send boundary without a model override", () => {
  const view = resolveComposerModel({
    studio: true,
    engines: [engine],
    modelKey: "claude-code::default",
    effort: null,
  });
  const sent = composerSendOptions({ ...view, studio: true, roles: null, preferences: {} }, "claude-code::default");
  assert.equal(sent.engine, "claude-code");
  assert.equal(sent.model, undefined);
});
