import { useState, type ReactNode } from "react";
import { IconButton, SIDE_TOOLTIP_OFFSET } from "../ui/kit.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { UserMessage } from "../chat/UserMessage.tsx";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import { CHAT_WORDS } from "../words.ts";
import { t } from "../../shared/i18n.ts";
import { chatMemory } from "../analytics/chat-memory.ts";
import { elapsedMs } from "../analytics/properties.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";

/** The line under a follow-up until the work reads it, always 24px tall (its buttons' height), so nothing moves. */
function WaitingLine({ children }: { children: ReactNode }) {
  return <div className="flex min-h-6 items-center gap-0.5 text-xs text-ink-3">{children}</div>;
}

/** What the line says while the message has nothing to offer in its place. */
function Sending() {
  return <span role="status">{CHAT_WORDS.sendingMessage}</span>;
}

/**
 * Send now, in Sending…'s place: it says the message is on its way and lets it go at once. Its
 * name and tooltip say the work it waits for stops first; the tooltip opens below, off the bubble.
 */
function SendNow({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const label = t("Stop and send now");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="hit-24 h-6 rounded-sm px-1.5 transition-[background-color,color] duration-[var(--dur)] ease-out enabled:hover:bg-control-hover enabled:hover:text-control-text-hover disabled:cursor-default disabled:opacity-35"
        >
          {t("Send now")}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={SIDE_TOOLTIP_OFFSET}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Sent during work and not saved yet: it waits where it will wait once saved. */
export function SendingMessage({ text, frames }: { text: string; frames?: ReferenceFrame[] }) {
  return (
    <div data-sending-message className="flex min-w-0 flex-col items-end gap-0.5">
      <UserMessage text={text} pending frames={frames} />
      <WaitingLine>
        <Sending />
      </WaitingLine>
    </div>
  );
}

/**
 * A saved follow-up waiting below the current work until the work reads it. One the running turn
 * has not taken (it waits for a turn of its own: a slash command, Studio's chat, a picture not saved
 * in the game) offers Send now in place of Sending… while there is work to stop, goes back to the
 * composer with Edit and is withdrawn with Remove; one handed to the running turn reads Sending…
 * and no longer can. How it arrives and leaves is the conversation's (`Presence`).
 */
export function QueuedMessage({
  threadId,
  messageId,
  text,
  sending = false,
  images,
  onNotice,
  onEdit,
  onSendNow,
}: {
  threadId: string;
  messageId: string;
  text: string;
  /** Handed to the running turn and not read yet: it can no longer be withdrawn. */
  sending?: boolean;
  /** Pictures sent with it: how many, when the log knows. */
  images?: { count?: number };
  onNotice: Notify;
  /** Take it off the queue and back to the composer; a refusal (a turn took it meanwhile) is shown here. */
  onEdit: () => Promise<void>;
  /** Stop the work it waits for, so it goes now; unset when there is no work to stop. */
  onSendNow?: () => void;
}) {
  const [changing, setChanging] = useState(false);
  /** One change at a time; a refused one says why, and the message stays as it was. */
  const change = async (act: () => Promise<void>) => {
    setChanging(true);
    try {
      await act();
    } catch (error) {
      notifyProblem(onNotice)(error);
      setChanging(false);
    }
  };
  const remove = () =>
    change(async () => {
      await window.studio.changeQueuedMessage(threadId, messageId, "remove");
      const sent = chatMemory.sends.get(messageId);
      track(AnalyticsEvent.QueuedMessageRemoved, sent ? { waited_ms: elapsedMs(sent.at, Date.now()) } : {});
    });
  return (
    <div data-queued-message={messageId} className="flex min-w-0 flex-col items-end gap-0.5">
      <UserMessage
        text={text}
        pending
        {...(images ? { threadId, imagesOf: messageId, imageCount: images.count } : {})}
      />
      <WaitingLine>
        {onSendNow && !sending ? <SendNow disabled={changing} onClick={onSendNow} /> : <Sending />}
        {!sending && (
          <>
            <IconButton
              icon="rename"
              label={t("Edit queued message")}
              size={12}
              className="chat-queued-action"
              tooltipSide="bottom"
              disabled={changing}
              onClick={() => void change(onEdit)}
            />
            <IconButton
              icon="trash"
              label={t("Remove queued message")}
              size={12}
              className="chat-queued-action"
              tooltipSide="bottom"
              disabled={changing}
              onClick={() => void remove()}
            />
          </>
        )}
      </WaitingLine>
    </div>
  );
}
