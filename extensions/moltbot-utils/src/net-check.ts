import net from "node:net";

interface CheckResult {
  text: string;
}

function checkPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

const ENDPOINTS = [
  { host: "github.com", port: 22, label: "GitHub SSH" },
  { host: "api.anthropic.com", port: 443, label: "Anthropic API" },
  { host: "api.openai.com", port: 443, label: "OpenAI API" },
  { host: "generativelanguage.googleapis.com", port: 443, label: "Google AI API" },
] as const;

export async function netCheck(): Promise<CheckResult> {
  const lines: string[] = [];
  let pass = 0;
  let warn = 0;

  const results = await Promise.all(
    ENDPOINTS.map(async (ep) => ({
      ...ep,
      ok: await checkPort(ep.host, ep.port),
    })),
  );

  for (const r of results) {
    if (r.ok) {
      lines.push(`[PASS] ${r.label} (${r.host}:${r.port}): reachable`);
      pass++;
    } else {
      lines.push(`[WARN] ${r.label} (${r.host}:${r.port}): unreachable`);
      warn++;
    }
  }

  lines.push("");
  lines.push(`--- Network Check: ${pass} PASS / ${warn} WARN ---`);

  return { text: lines.join("\n") };
}
