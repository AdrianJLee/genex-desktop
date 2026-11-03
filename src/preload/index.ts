/**
 * Renderer bridge. Sandboxed preloads must be CommonJS, and the surface is deliberately a fixed
 * list of named calls: the renderer can ask the substrate to do specific things, never to
 * evaluate arbitrary code or touch the filesystem. The calls are built in `studio-bridge.ts`, typed
 * by the channel map in `shared/ipc-channels.ts`, and put in the page by `main-world.ts`.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { systemLanguagesFromArgs } from "../shared/locale.ts";
import { crossableCalls, installInMainWorld } from "./main-world.ts";
import { createStudioBridge } from "./studio-bridge.ts";

// Installed in the page's own world, so a failure keeps its code and channel (`main-world.ts`).
contextBridge.executeInMainWorld({
  func: installInMainWorld,
  args: ["studio", crossableCalls(createStudioBridge(ipcRenderer, webUtils, systemLanguagesFromArgs(process.argv)))],
});

export type { StudioApi } from "../shared/studio-api.ts";
