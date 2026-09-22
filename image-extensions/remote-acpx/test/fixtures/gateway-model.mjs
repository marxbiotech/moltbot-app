// Deterministic model peer: real Gateway tool admission and completion delivery,
// without provider credentials or a model deciding which test to run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";

export async function startGatewayModel({ skillPath, cwd }) {
  const state = { requests: 0, skillRead: false, spawned: false, completed: false, errors: [] };
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      state.requests++;
      const messages = body.messages ?? [];
      const tools = (body.tools ?? []).map((tool) => tool.function?.name);
      const text = messages.map((message) => JSON.stringify(message.content)).join("\n");
      const toolResults = messages.filter((message) => message.role === "tool");
      let tool;
      let content;
      if (text.includes("remote-agent-owned-prompt") && text.includes('\\"history\\"')) {
        state.completed = true;
        content = "REMOTE-ACP-PARENT-RESULT: remote agent completed the requested work.";
      } else if (!state.skillRead) {
        assert.ok(
          text.includes("remote-acp-router"),
          "plugin skill is discoverable in model context",
        );
        assert.ok(tools.includes("read"), "the agent can read its routing skill");
        tool = { name: "read", arguments: { path: skillPath } };
        state.skillRead = true;
      } else if (!state.spawned) {
        assert.ok(
          toolResults.some((message) =>
            JSON.stringify(message.content).includes("# Remote ACP Router"),
          ),
          "the real read tool returned the packaged skill",
        );
        assert.ok(tools.includes("sessions_spawn"), "ACP spawn is available to the agent");
        tool = {
          name: "sessions_spawn",
          arguments: {
            runtime: "acp",
            agentId: "fixture",
            cwd,
            mode: "run",
            streamTo: "parent",
            task: "remote-agent-owned-prompt",
          },
        };
        state.spawned = true;
      } else {
        const spawnCall = messages
          .flatMap((message) => message.tool_calls ?? [])
          .find((call) => call.function?.name === "sessions_spawn");
        const result = toolResults.find((message) => message.tool_call_id === spawnCall?.id);
        assert.ok(result, `spawn was not admitted: ${JSON.stringify(toolResults)}`);
        const raw =
          typeof result.content === "string"
            ? result.content
            : result.content.map((part) => part.text ?? "").join("");
        const admitted = JSON.parse(raw);
        assert.equal(admitted.status, "accepted", `spawn was rejected: ${raw}`);
        state.childSessionKey = admitted.childSessionKey;
        state.runId = admitted.runId;
        content = "Remote work was admitted; I will report its result when it completes.";
      }
      const id = `chatcmpl-${randomUUID()}`;
      const toolCalls = tool
        ? [
            {
              index: 0,
              id: `call_${randomUUID()}`,
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
            },
          ]
        : undefined;
      const delta = { role: "assistant", ...(toolCalls ? { tool_calls: toolCalls } : { content }) };
      const finishReason = tool ? "tool_calls" : "stop";
      if (body.stream) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        for (const choice of [
          { index: 0, delta, finish_reason: null },
          { index: 0, delta: {}, finish_reason: finishReason },
        ]) {
          response.write(
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "noop", choices: [choice] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            model: "noop",
            choices: [{ index: 0, message: delta, finish_reason: finishReason }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
        );
      }
    } catch (error) {
      state.errors.push(error.message);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
