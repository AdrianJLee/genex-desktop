/**
 * What the open Loop's tools answer its lead, the words of its close, and Genex's lines about what it
 * did with the folder and the project's app (facts only: what the lead can do is in its tools'
 * descriptions). Engine neutral: a project's own words come from its facts, its plugins and its
 * skills, never from here. Model-facing: the lead reads them as written.
 */
import { clause } from "../held-words.ts";
import { WorkerTool } from "../../workers/contract.ts";
import { OpenTool } from "./contract.ts";

/** What the open Loop's tools answer, and the words of its close. */
export const OPEN_WORDS = {
  stopped: "The Loop was stopped; end your turn.",
  unknownTool: (name: string) => `unknown tool: ${name}`,
  needsText: "note needs text",
  noted: "noted",
  finishUnderWay: "Your finish is already being checked; wait for its answer.",
  ending: "The Loop is already ending; end your turn.",
  /** A save point, a rewind, a restart or a finish once the Loop is paused (its app couldn't be brought back, or the lead paused it). */
  paused:
    "The Loop is paused: Genex couldn't bring the project's app back, or you paused it for the person. Nothing was kept or checked; end your turn.",
  needsWhy: `${OpenTool.Pause} needs why: what stops the goal and what the person should do.`,
  pausing:
    "The Loop pauses when this turn ends, with your words for the person. End your turn now with the same two sentences.",
  /** A claim while a worker writes in the folder in place: the reviewer would read a folder that keeps changing. */
  writerAtWork: (ids: readonly string[]) =>
    `A worker writes in the folder in place (${ids.join(", ")}), so a reviewer would read a folder that keeps changing: nothing was checked. Wait for it (${WorkerTool.Wait}) or stop it (${WorkerTool.Stop}), then claim the goal.`,
  /** A claim while a rewind or a restart the lead asked for still waits for the turn's end. */
  askFirst:
    "Your rewind or restart runs when this turn ends, so there is nothing to check yet: end your turn, then claim the goal in the next.",
  needsSummary: "finish needs a summary of what the project holds now.",
  /** A web game's page failed its health check at the finish (`line`: health-check.ts `healthLine`): the Loop goes on. */
  unhealthy: (line: string) => `Not finished. ${line}`,
  accepted: "Accepted: the Loop is closed. End your turn with a one-paragraph summary for the person.",
  /** A yes whose close outlasts the lead's call: it goes on, and the lead changes nothing more. */
  acceptedClosing:
    "Accepted: the Loop is closing, and Genex keeps its last work now. Change nothing more; end your turn with a one-paragraph summary for the person.",
  /** Any other close that outlasts the lead's call. */
  closing:
    "The Loop is closing, and Genex keeps its last work now. Change nothing more; end your turn with a one-paragraph summary for the person.",
  personFinished:
    "The person asked the Loop to finish: it is closed. End your turn with a one-paragraph summary for the person.",
  needsLabel: `${OpenTool.SavePoint} needs a label.`,
  /** A save point or a finish while Genex brings the project's app back: nothing is kept or checked. */
  recovering:
    "Genex is bringing the project's app back; nothing was kept or checked. Try again once it says the app is back.",
  saved: (label: string, notes: readonly string[], shows: string | null = null) =>
    [
      `Saved save point "${label}".`,
      ...(notes.length ? [`The project's plugins said: ${notes.join(" ")}`] : []),
      ...(shows ? [shows] : []),
    ].join(" "),
  notSaved: (why: string) => `No save point was made, and nothing was kept: ${clause(why)}.`,
  rewindLater: (label: string) =>
    `Genex goes back to save point "${label}" when this turn ends; end your turn when you are ready.`,
  noSuchPoint: (label: string, labels: readonly string[]) =>
    labels.length
      ? `There is no save point "${label}". The save points are: ${labels.map((one) => `"${one}"`).join(", ")}.`
      : `There is no save point "${label}": none was kept yet.`,
  restartLater: "Genex restarts the project's app when this turn ends; no file changes.",
} as const;

/** What Genex did between the lead's turns and while it worked: one line of the run's log each (`NoteKind`). */
export const OPEN_NEWS = {
  autosaved: (label: string) => `Your turn ended with unsaved work, so Genex saved it as save point "${label}".`,
  notAutosaved: (why: string) => `Your turn ended with unsaved work, and Genex couldn't keep it: ${clause(why)}.`,
  rewound: (label: string) => `Genex went back to save point "${label}" before this turn, as you asked.`,
  noRewind: (label: string, why: string) => `Genex couldn't go back to save point "${label}": ${clause(why)}.`,
  restarted: "Genex restarted the project's app before this turn, as you asked; no file changed.",
  noRestart: (why: string) => `Genex couldn't restart the project's app: ${clause(why)}.`,
  notAnswering: (why: string) => `The project's app didn't answer again: ${clause(why)}.`,
  /** Why nothing was kept or restored at a turn's end: a recovery under way. */
  bringingBack: "Genex is bringing the project's app back",
  askWaits:
    "Genex is bringing the project's app back, so the rewind or restart you asked for waits until a turn ends after it is back.",
  /** A rewind or restart asked for while a worker writes in the folder in place: it waits for that worker. */
  askWaitsForWriter: (ids: readonly string[]) =>
    `A worker writes in the folder in place (${ids.join(", ")}), so the rewind or restart you asked for waits until a turn ends after it is done.`,
  /** No autosave while a worker writes in the folder in place: it would keep that worker's half-done files. */
  notAutosavedWriter: (ids: readonly string[]) =>
    `A worker writes in the folder in place (${ids.join(", ")}), so Genex kept no autosave of your turn.`,
  /** The writers in place Genex stopped before it took the folder back to a save point. */
  writersStopped: (ids: readonly string[]) =>
    `Genex stopped ${ids.join(", ")} first: it wrote in the folder in place, and the folder went back under it.`,
  /** Why a writer in place was stopped, as its end record says it. */
  writerStoppedWhy: "Genex stopped it while it brought back the project's app, which had stopped answering",
  rewindDropped: (label: string) =>
    `Before the Loop paused you asked to go back to save point "${label}"; it paused first, so nothing went back.`,
  restartDropped:
    "Before the Loop paused you asked to restart the project's app; it paused first, so it wasn't restarted.",
  /** Said the moment Genex sees the project's app has stopped answering, before its recovery. */
  appStopping: "The project's app isn't answering: Genex is bringing it back now.",
  appBack: (label: string | null) =>
    label
      ? `The project's app stopped, and Genex reopened it. Work since save point "${label}" may be lost.`
      : "The project's app stopped, and Genex reopened it. Work not yet saved in it may be lost.",
  wentBack: (label: string) =>
    `The project's app stopped and wouldn't reopen on the folder as it was, so Genex went back to save point "${label}". Work since it is gone from the folder.`,
} as const;
