/**
 * The open chat answers Play on a game with no app to play yet (`game-play.ts`): it sends "Run the
 * game" as the person's message (`SendSource.RunTheGame`), and the chat's agent packages the game and
 * starts it. A Play while that send is under way sends nothing more.
 */
import { useEffect, useRef } from "react";
import { SendSource } from "../analytics/chat-vocabulary.ts";
import { RUN_THE_GAME_EVENT, type RunTheGame } from "../game-play.ts";
import { oneAtATime } from "../keep-building.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { GAME_PLAY_WORDS } from "../words.ts";
import type { SendAnswered } from "./use-submit.ts";

export function useRunTheGame(threadId: string | undefined, submit: SendAnswered, onNotice: Notify): void {
  const latest = useRef({ threadId, submit, onNotice });
  latest.current = { threadId, submit, onNotice };
  useEffect(() => {
    const sendOnce = oneAtATime(async (): Promise<boolean> => {
      const { submit: send, onNotice: notify } = latest.current;
      return send(GAME_PLAY_WORDS.runTheGame, undefined, true, SendSource.RunTheGame).catch((error: unknown) => {
        notifyProblem(notify)(error);
        return false;
      });
    });
    const run = (event: Event): void => {
      const detail = (event as CustomEvent<RunTheGame>).detail;
      if (!detail?.threadId || detail.threadId !== latest.current.threadId) return;
      detail.taken = true;
      void sendOnce().then(detail.answer);
    };
    window.addEventListener(RUN_THE_GAME_EVENT, run);
    return () => window.removeEventListener(RUN_THE_GAME_EVENT, run);
  }, []);
}
