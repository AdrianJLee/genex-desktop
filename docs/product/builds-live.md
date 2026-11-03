# Builds and Live

## From a request to a game

There is no mode to set: the chat's agent answers, edits directly or starts a Loop, as the
request needs. In a Loop the chat leads and builds beside workers
[in the game's folder](projects-engines.md#loops-in-place). Judges answer only when the lead asks. A Loop goes on, with no clock, until its lead finishes it or a turn ends with nothing at
work. Acceptance survives workers and restarts; external blockers pause it at its checkpoint.
Asked to finish, the lead's last turn ends it
([details](../harness-runtime.md#goal-completion-and-worker-approvals)). A local model's chat
(Ollama) answers and edits; it starts no Loop.

An active run opens Builds once; a build shown from chat, or empty Builds, opens Live. Files and images opened from chat get closable tabs.

## The two views

**Live** plays the browser game natively; previews pause unwatched or hidden. Pages load
hidden at Live's size, never at none. The strip
holds Live/Builds/Assets, Reload, Play/Stop and Sound (⌥⌘M; heard when shown) once the
game has content, Full screen (hold Esc), plugin actions, Multiplayer, Publish. Stop halts it until
Play/Reload. An empty scaffold shows “Ready for your first idea”, or
“Building your game” with Watch progress, then Play latest; the first healthy build shows itself.
Opening a game starts nothing: Live keeps its game. Otherwise only the user changes Live (Play,
Reload, Make live) or a finished Unity/Godot `web/` build. A changed game folder or a broken shown
build lights Reload; hidden and not stopped, they go in at once. The
preview's network is open, as a web page's. Other folders' views:
[projects](projects-engines.md#lives-views).

**Builds** is a graph: You asked, a row per part, Your build, then the lead while no part
works. Tries at one step fold into one node; what reached the build forms the line, the rest
hangs below. Tries a pause cut off show Paused until added. An eye opens the reviewers' notes. A
working node shows its agent's screen; a selected one opens as a card. **Follow up in chat** notes
the next message to its build. Tabs (one per build; past three, one picker, newest first) and chat
cards open earlier builds. A Loop, workers, jobs or a claim make a tree: the lead (jobs below),
then, when asked, a finish check: Checking, Not yet, Done or Stopped. A Loop's line is its save points
(an earlier Genex's web Loop: its builds); workers hang off them, solid under the one taking their
work, else ghosts; past three finished per point fold into “+N workers”. Compares pair only one frame (consecutive points or builds, asset versions) whose pixels
differ; else the card says nothing visibly changed.

Agents test hidden (Godot too), never Live. A finished worker, its merge and Live's revision
differ; chat shows a delivery's capture, failures too. A web game's finish first loads its page
once (`?genex-shot=1` a game may read); unless it loads, throws nothing uncaught and is not blank,
the Loop goes on.

## Continuation and interruption

After a chat-led build, its session takes follow-ups: edits, resuming a paused run, or a
new Loop for more work than a reply holds. **Stop** interrupts at once, keeping finished
work: a stopped Loop shows one Stopped line with Resume. Resume refuses an earlier Genex's
paused web Loop; its card says the work is kept in git, and its words name the ref for the chat to bring in. Limit, outage and crash pauses resume twice unless stopped (Settings → Harness); sign-in
pauses wait. A crash or restart settles abandoned activity from saved state.

## Where to work

- [WorkspaceStage](../../src/renderer/shell/WorkspaceStage.tsx) picks the stage,
  [PreviewPanel](../../src/renderer/panels/PreviewPanel.tsx) its tabs; [run-steps](../../src/renderer/run-steps.ts)
  folds steps that [RunGraph](../../src/renderer/panels/RunGraph.tsx) and
  [RunInspector](../../src/renderer/panels/RunInspector.tsx) draw.
- [Conversation lifecycle](../conversation-lifecycle.md): queue, continuation and Stop.
- [Architecture](../agent/architecture.md) and [Verification](../agent/verification.md): the run,
  preview and recovery contracts.
