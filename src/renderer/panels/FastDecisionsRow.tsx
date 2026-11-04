/**
 * Settings → Model Providers, TypeSafe's row: the key a play-test's pilot asks Jev with for its
 * moves, several times a second. Optional: without a key, pilots choose by their own order and
 * nothing else changes. The key goes straight to main, which checks it with TypeSafe and keeps it in
 * the OS secret store; it is never shown again, and the field forgets it the moment it is sent.
 */
import { type JSX, useEffect, useState } from "react";
import { FastDecisionKeyState, type FastDecisionKeyStatus } from "../../shared/fast-decisions.ts";
import { Button } from "../ui/Button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icons.tsx";
import { FAST_DECISION_WORDS, METERED_PROVIDER_WORDS } from "../words.ts";
import { ItemWords, KeyEntry, useRun } from "./MeteredProviders.tsx";
import { type ProviderWords, RowHeading, RowTone, type RowView } from "./provider-row.tsx";

const WORDS = FAST_DECISION_WORDS;
const ROW_WORDS: ProviderWords = { name: WORDS.name, plans: "", guide: WORDS.keysUrl };

/** What the row says after a save that kept nothing: TypeSafe's refusal, or the detail main gave. */
function saveProblem(status: FastDecisionKeyStatus): string | null {
  if (status.state === FastDecisionKeyState.Ready || status.state === FastDecisionKeyState.Missing) return null;
  return status.detail ?? WORDS.refused;
}

/** The connected row's menu: replace the key, or remove it. */
function KeyMenu({ onReplace, onRemove }: { onReplace: () => void; onRemove: () => void }): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={WORDS.keyMenu}>
          {WORDS.key}
          <Icon name="chevron-down" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={onReplace}>
          <ItemWords title={WORDS.replace} line={WORDS.replaceLine} />
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRemove}>{WORDS.remove}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The row's heading by the key's state: saved, or waiting for one. */
function rowView(status: FastDecisionKeyStatus | null, menu: JSX.Element): RowView {
  if (status?.state === FastDecisionKeyState.Ready)
    return {
      tone: RowTone.Connected,
      status: METERED_PROVIDER_WORDS.connected,
      line: WORDS.connectedLine,
      actions: menu,
    };
  return {
    tone: RowTone.Off,
    status: METERED_PROVIDER_WORDS.notConnected,
    line: WORDS.notConnectedLine,
    actions: null,
  };
}

export function FastDecisionsRow(): JSX.Element {
  const { run, error } = useRun();
  const [status, setStatus] = useState<FastDecisionKeyStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    // A status that can't be read is no key: the row then offers the field.
    const shown = (read: FastDecisionKeyStatus) => live && setStatus(read);
    window.studio.typeSafeKeyStatus().then(shown, () => shown({ state: FastDecisionKeyState.Missing }));
    return () => {
      live = false;
    };
  }, []);
  const save = (key: string): Promise<void> =>
    run(async () => {
      setSaving(true);
      setProblem(null);
      try {
        const saved = await window.studio.typeSafeKeySave(key);
        const refusal = saveProblem(saved);
        setProblem(refusal);
        if (!refusal) {
          setReplacing(false);
          setStatus(saved);
        }
      } finally {
        setSaving(false);
      }
    });
  const remove = () =>
    void run(async () => {
      setProblem(null);
      setStatus(await window.studio.typeSafeKeyClear());
    });
  const menu = <KeyMenu onReplace={() => setReplacing(true)} onRemove={remove} />;
  const view = rowView(status, menu);
  const asksForKey = replacing || (status !== null && status.state !== FastDecisionKeyState.Ready);
  const locked = status?.state === FastDecisionKeyState.Locked ? (status.detail ?? null) : null;
  const shown = error ?? problem ?? locked;
  return (
    <section aria-label={WORDS.name} className="settings-card gap-2" data-provider-row="typesafe">
      <RowHeading words={ROW_WORDS} version={undefined} tone={view.tone} status={view.status} view={view} />
      {asksForKey && (
        <KeyEntry
          saving={saving}
          onSave={save}
          onCancel={replacing ? () => setReplacing(false) : null}
          words={WORDS}
          onGetKey={() => void window.studio.openUrl(WORDS.keysUrl)}
        />
      )}
      {shown && (
        <p role="alert" className="text-body-sm text-red">
          {shown}
        </p>
      )}
    </section>
  );
}
