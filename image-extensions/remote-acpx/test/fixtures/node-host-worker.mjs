import { spawn } from "node:child_process";

let request;
process.on("message", (message) => {
  if (message.type === "start") {
    request = message.request;
    process.send({ type: "started" });
    if (request.op === "turn" && request.input.text === "wait") return;
    if (request.op === "turn" && request.input.text === "ignore-cancel") {
      process.on("SIGTERM", () => {});
      return;
    }
    if (request.op === "turn" && request.input.text === "orphan-child") {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>{}); process.send({ready:true}); setInterval(()=>{},1000)",
        ],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      child.once("message", () =>
        process.send({ type: "event", event: { type: "status", text: String(child.pid) } }),
      );
      return;
    }
    process.send(
      {
        type: "value",
        value: {
          op: request.op,
          config: message.config,
          ...(request.input.agent === "report-pid" ? { pid: process.pid } : {}),
        },
      },
      () => {
        if (!["ensure", "setMode", "setConfigOption"].includes(request.op)) process.disconnect();
      },
    );
  } else if (
    message.type === "cancel" &&
    !["ignore-cancel", "orphan-child"].includes(request?.input.text)
  ) {
    process.send({ type: "result", result: { status: "cancelled" } }, () => process.disconnect());
  }
});
