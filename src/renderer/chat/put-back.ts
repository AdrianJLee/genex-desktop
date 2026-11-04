/**
 * What comes back to the composer to be changed and sent again: a rewound message, or a waiting
 * one taken back off the queue. Its words go before any draft already there, the pictures the
 * composer had attached come back with them, and the cursor goes to the end of the prompt.
 */
import type { StudioApi } from "../../shared/studio-api.ts";
import { COMPOSE_FRAMES_EVENT } from "../ui/PromptBar.tsx";

/** A sent message's pictures: how many of them the composer had attached (the rest came from paths its words name). */
export interface SentPictures {
  messageId: string;
  pickedImages: number;
}

/** A waiting message to take back to the composer: its chat, its words and its pictures. */
export interface TakenBack extends SentPictures {
  threadId: string;
  text: string;
}

/** The composer's prompt, where a message comes back. */
export const promptInput = (): HTMLTextAreaElement | null => document.querySelector("[data-promptbar] textarea");

/** Only the pictures the composer had attached come back: the rest came from paths the text still names. */
export function restorePictures(threadId: string, sent: readonly SentPictures[]): void {
  for (const message of sent) {
    if (!message.pickedImages) continue;
    void window.studio
      .messageImages(threadId, message.messageId)
      .then((frames) =>
        window.dispatchEvent(
          new CustomEvent(COMPOSE_FRAMES_EVENT, {
            detail: { conversationKey: threadId, frames: frames.slice(0, message.pickedImages) },
          }),
        ),
      )
      .catch(() => {});
  }
}

/** Put the cursor at the end of the prompt once the words that came back are in it. */
export function focusPromptEnd(): void {
  requestAnimationFrame(() => {
    const prompt = promptInput();
    prompt?.focus();
    prompt?.setSelectionRange(prompt.value.length, prompt.value.length);
  });
}

/**
 * Take a waiting message back to change it: it leaves the queue first, so it is never both
 * answered and in the composer. One a turn took meanwhile stays where it is, and the refusal is
 * the caller's to show.
 */
export async function takeBack(
  api: Pick<StudioApi, "changeQueuedMessage">,
  message: TakenBack,
  putBack: (message: TakenBack) => void,
): Promise<void> {
  await api.changeQueuedMessage(message.threadId, message.messageId, "remove");
  putBack(message);
}
