/**
 * The open chat answers Keep building (`keep-building.ts`): a tap on its result card or on its
 * run's Builds card sends what is left as the person's message (`SendSource.KeepBuilding`), and the
 * chat's agent decides how to go on with it. It answers the tap whether the message went out: a tap
 * while that send is under way, or a sign-in first, sends nothing, and the button stays.
 */
import { useEffect, useRef } from "react";
import { SendSource } from "../analytics/chat-vocabulary.ts";
import { KEEP_BUILDING_EVENT, type KeepBuilding, keepBuildingAsk, oneAtATime } from "../keep-building.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import type { SendAnswered } from "./use-submit.ts";

export function useKeepBuilding(threadId: string | undefined, submit: SendAnswered, onNotice: Notify): void {
  const latest = useRef({ threadId, submit, onNotice });
  latest.current = { threadId, submit, onNotice };
  useEffect(() => {
    const sendOnce = oneAtATime(async (notDone: string[]): Promise<boolean> => {
      const { submit: send, onNotice: notify } = latest.current;
      return send(keepBuildingAsk(notDone), undefined, true, SendSource.KeepBuilding).catch((error: unknown) => {
        notifyProblem(notify)(error);
        return false;
      });
    });
    const keep = (event: Event): void => {
      const detail = (event as CustomEvent<KeepBuilding>).detail;
      if (!detail?.threadId || detail.threadId !== latest.current.threadId) return;
      detail.taken = true;
      void sendOnce(detail.notDone).then(detail.answer);
    };
    window.addEventListener(KEEP_BUILDING_EVENT, keep);
    return () => window.removeEventListener(KEEP_BUILDING_EVENT, keep);
  }, []);
}
