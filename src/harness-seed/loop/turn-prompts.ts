/**
 * The note a chat turn on an engine with no session of its own (Ollama's tool loop) adds to its
 * model's prompt to put attached pictures in front of the model.
 */

/** The note that puts this turn's pictures in front of the model. */
export function lookAtPictures(labels: string): string {
  return `Look at these pictures (${labels}). A path is not a picture.`;
}
