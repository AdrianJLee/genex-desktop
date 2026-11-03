/**
 * How a message reached a session, and who wrote it. A module of its own: the queue
 * (message-queue.ts), the turn's runner (chat-steer.ts) and the lead's loop (director/) all read it.
 */

/**
 * How a steered message reached the session answering the chat (`coordinator_message_delivered`
 * `how`, and the host's `engine.steer` answer): in the prompt the session was about to read, read
 * mid-turn by an engine that takes input, or by interrupting the session and resuming it with the
 * message in front — or, sent while a run's lead works, handed to that lead (`lead`: `into` is
 * its run; live-chat.ts). The app's copy is `SteerDelivery` in `shared/message-queue.ts`; logs keep
 * the values: never rename one.
 */
export const SteerDelivery = {
  Prompt: "prompt",
  Native: "native",
  Interrupt: "interrupt",
  Lead: "lead",
} as const;
export type SteerDelivery = (typeof SteerDelivery)[keyof typeof SteerDelivery];

/**
 * Who wrote a message into a session (`engine.steer`'s messages, `engine.delegate`'s prompt): the
 * person, or Genex itself, whose lines each engine shows as not the person's. The app's copy is
 * `MessageFrom` in `shared/engine-requests.ts`: never rename a value.
 */
export const MessageFrom = {
  Person: "person",
  Genex: "genex",
} as const;
export type MessageFrom = (typeof MessageFrom)[keyof typeof MessageFrom];

/** The person wrote it, not Genex: a message with no `from` is theirs. */
export const fromThePerson = (message: Readonly<Record<string, unknown>>): boolean =>
  message.from !== MessageFrom.Genex;
