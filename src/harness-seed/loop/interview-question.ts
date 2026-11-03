import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { clip, CLIP_REASON } from "./text.ts";

/** How long a recorded question and its recap may be, how many choices it offers, and how long each choice's label. */
const QUESTION_CHARS = 600;
const RECAP_CHARS = 300;
const MAX_CHOICES = 3;
const CHOICE_LABEL_CHARS = 160;

/** Intake uses a recorded question, then resumes on the next normal user message.
 * No provider session, permission grant or timeout is held while the user decides. */
export function interviewQuestion(args: AnyRecord = {}): {
  question: string;
  recap?: string;
  choices: Array<{ id: string; label: string; description?: string }>;
} {
  const question = typeof args.question === "string" ? args.question.trim().slice(0, QUESTION_CHARS) : "";
  if (!question) throw new Error("Ask one short question.");
  const recap = typeof args.recap === "string" ? args.recap.trim().slice(0, RECAP_CHARS) : "";
  const choices = String(args.options ?? "")
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, MAX_CHOICES)
    .map((line, index) => {
      const [label, ...description] = line.split("|");
      return {
        id: String(index),
        label: (label ?? "").trim().slice(0, CHOICE_LABEL_CHARS),
        ...(description.length ? { description: clip(description.join("|").trim(), CLIP_REASON) } : {}),
      };
    })
    .filter((choice) => choice.label);
  return { question, ...(recap ? { recap } : {}), choices };
}

/** Record the question on the turn: the chat shows its card, and the answer comes as the next message. */
export async function recordInterviewQuestion(ctx: ToolCtx, args: AnyRecord): Promise<void> {
  const question = interviewQuestion(args);
  await ctx.call(HostMethod.TurnAppend, {
    turnId: ctx.turnId!,
    batch: [{ type: EventKind.Custom, event_type: RunEvent.InterviewQuestion, payload: question }],
  });
}

export const askUser: HarnessTool = {
  name: "ask_user",
  description:
    "Ask one necessary question in the chat's answer panel. Offer up to 3 concise choices, recommended first. The user can also type a different answer. End your reply after calling this; wait for the next user message before starting a run. Never use this for progress updates, permission to do work already requested, or a reply to a greeting or small talk (answer that in words).",
  parameters: {
    type: "object",
    properties: {
      recap: {
        type: "string",
        description: "Optional: one short sentence on what you found or just did, shown above the question.",
      },
      question: {
        type: "string",
        description: "One short question whose answer changes what you do next.",
      },
      options: {
        type: "string",
        description:
          "Up to 3 choices, one per line: Label | optional short description. Put (Recommended) in the first label when appropriate. No Other choice; the composer supports custom answers.",
      },
    },
    required: ["question"],
  },
  async execute(args, ctx) {
    await recordInterviewQuestion(ctx, args);
    return { ok: true, content: "Question shown. Wait for the user's next message.", stopTurn: "done" };
  },
};
