/**
 * "Raise context to 16K": a copy of an Ollama model that runs with a larger context. Ollama loads a
 * model at its own default (4K) unless the model's Modelfile sets `num_ctx`, and Genex talks to it
 * through the OpenAI-compatible endpoint, which cannot set it per request. A copy made with
 * `/api/create` shares the original's weights, so it costs no disk beyond a manifest.
 */

/** The context the copy runs with (its `num_ctx`). */
export const RAISED_CONTEXT_TOKENS = 16_384;

/** What a copy's tag ends with: `-16k`. */
const RAISED_SUFFIX = `-${RAISED_CONTEXT_TOKENS / 1024}k`;

/**
 * The copy's name: the original's tag with `-16k` after it (`qwen3:8b` → `qwen3:8b-16k`). A name
 * with no tag is Ollama's `latest`, so its copy is `name:latest-16k`.
 */
export function raisedContextName(model: string): string {
  const tagged = (model.split("/").at(-1) ?? "").includes(":");
  return `${tagged ? model : `${model}:latest`}${RAISED_SUFFIX}`;
}

/** Is this already a copy made to raise the context? Raising it again would not help. */
export function isRaisedContextName(model: string): boolean {
  return model.endsWith(RAISED_SUFFIX);
}
