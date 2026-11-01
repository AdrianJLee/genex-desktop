/**
 * The fast decision model's key (Settings → Model Providers → TypeSafe) and the decider a play hands
 * a pilot's asks to. Optional: with no key saved, `decider()` is null and pilots choose by their own
 * order. The key is checked with TypeSafe before it is kept, lives in the OS secret store under
 * `userData/secrets/providers/` (a folder no agent process may read), and never leaves main.
 */
import { t } from "../../shared/i18n.ts";
import { type FastDecider, FastDecisionKeyState, type FastDecisionKeyStatus } from "../../shared/fast-decisions.ts";
import { type ApiKeyStore, cleanApiKey } from "../../substrate/provider-keys.ts";
import { SecretStorageUnavailableError } from "../../substrate/secrets.ts";
import { checkTypeSafeKey, type TypeSafeOptions, typeSafeDecider } from "../../substrate/typesafe.ts";

/** Words main says of the key; functions, as main sets its language after this loads. */
const MESSAGE = {
  BadShape: () => t("That doesn't look like a TypeSafe key. Copy it again from TypeSafe's console."),
  Unreachable: (why: string) => t("Couldn't reach TypeSafe to check the key: {why}", { why }),
} as const;

export class FastDecisions {
  readonly #keys: ApiKeyStore;
  readonly #options: TypeSafeOptions;

  constructor(keys: ApiKeyStore, options: TypeSafeOptions = {}) {
    this.#keys = keys;
    this.#options = options;
  }

  /** The saved key, null when there is none; a locked store answers its error. */
  async #read(): Promise<string | null | SecretStorageUnavailableError> {
    try {
      return await this.#keys.read();
    } catch (err) {
      if (err instanceof SecretStorageUnavailableError) return err;
      throw err;
    }
  }

  /** Whether a key is saved (it was checked when it was), or why none can be read. */
  async status(): Promise<FastDecisionKeyStatus> {
    const key = await this.#read();
    if (key instanceof SecretStorageUnavailableError)
      return { state: FastDecisionKeyState.Locked, detail: key.message };
    return { state: key ? FastDecisionKeyState.Ready : FastDecisionKeyState.Missing };
  }

  /** Check a pasted key with TypeSafe and keep it only when TypeSafe takes it; the key never comes back. */
  async save(value: unknown): Promise<FastDecisionKeyStatus> {
    const key = cleanApiKey(value);
    if (!key) return { state: FastDecisionKeyState.Refused, detail: MESSAGE.BadShape() };
    const check = await checkTypeSafeKey(key, this.#options);
    if (!check.ok && check.refused) return { state: FastDecisionKeyState.Refused };
    if (!check.ok) return { state: FastDecisionKeyState.Unreachable, detail: MESSAGE.Unreachable(check.detail) };
    try {
      await this.#keys.write(key);
    } catch (err) {
      if (err instanceof SecretStorageUnavailableError)
        return { state: FastDecisionKeyState.Locked, detail: err.message };
      throw err;
    }
    return this.status();
  }

  /** Forget the saved key: pilots then choose by their own order. */
  async clear(): Promise<FastDecisionKeyStatus> {
    await this.#keys.clear();
    return this.status();
  }

  /** A decider on the saved key, warmed so its first decision finds the connection open; null without a key. */
  async decider(): Promise<FastDecider | null> {
    const key = await this.#read();
    if (!key || key instanceof SecretStorageUnavailableError) return null;
    const decider = typeSafeDecider(key, this.#options);
    void decider.warm();
    return decider;
  }
}
