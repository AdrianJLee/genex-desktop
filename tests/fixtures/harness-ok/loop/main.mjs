/** Minimal well-behaved harness used to test the host contract. */
export async function createStudio(host) {
  let status = "idle";
  return {
    status: () => status,
    // Declared so the host's capability handshake can be tested; a harness without the
    // property must read as [], never as "everything".
    capabilities: ["autopilot"],
    async healthcheck() {
      // A real turn round-trip against the substrate, not just "process is alive".
      const head = await host.call("events.head", { threadId: host.threadId ?? "probe" });
      return { ok: true, head };
    },
    async dispatch(action) {
      status = `handling ${action.type}`;
      if (action.type === "user_message") {
        await host.call("events.append", {
          threadId: action.threadId,
          batch: [{ type: "messages", messages: [{ role: "assistant", content: `echo: ${action.text}` }] }],
        });
        host.notify("chat.delta", { text: `echo: ${action.text}` });
      }
      if (action.type === "boot_notice") {
        host.notify("boot", action.notice);
      }
      if (action.type === "run_start" && action.run.goal === "explode") {
        process.exit(9); // simulate a self-inflicted crash
      }
      if (action.type === "run_start" && action.run.goal === "wedge") {
        const until = Date.now() + 60_000;
        while (Date.now() < until) {
          /* block the event loop: heartbeats stop, the host must notice */
        }
      }
      status = "idle";
    },
    async shutdown() {
      status = "shutting down";
    },
  };
}
