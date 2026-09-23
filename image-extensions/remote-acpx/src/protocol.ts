import { z } from "zod";
import type {
  AcpRuntimeEvent,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "openclaw/plugin-sdk/acp-backend";
import type { NodeConfig } from "./config.js";

export const COMMAND = "remote-acpx.execute";
export const BACKEND = "remote-acpx";
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const text = z.string().min(1);
export const ownerSchema = z.strictObject({ sessionKey: text, agentId: text });
export type Owner = z.infer<typeof ownerSchema>;
export const handleSchema = z.strictObject({
  sessionKey: text,
  agentId: text.optional(),
  backend: text,
  runtimeSessionName: text,
  cwd: text.optional(),
  acpxRecordId: text.optional(),
  backendSessionId: text.optional(),
  agentSessionId: text.optional(),
  appliedModel: z
    .union([
      z.strictObject({ kind: z.literal("applied"), model: text }),
      z.strictObject({ kind: z.literal("dropped") }),
    ])
    .optional(),
  appliedThinking: z
    .union([
      z.strictObject({ kind: z.literal("applied"), thinking: text }),
      z.strictObject({ kind: z.literal("dropped") }),
    ])
    .optional(),
});
const ensureSchema = ownerSchema.extend({
  persistedHandle: handleSchema.optional(),
  agent: text,
  mode: z.enum(["persistent", "oneshot"]),
  resumeSessionId: text.optional(),
  model: text.optional(),
  modelExplicit: z.boolean().optional(),
  thinking: text.optional(),
  thinkingExplicit: z.boolean().optional(),
  cwd: text.optional(),
  env: z.record(text, z.string()).optional(),
});
const handleInput = z.strictObject({ handle: handleSchema });
export const requestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("ensure"), owner: ownerSchema, input: ensureSchema }),
  z.strictObject({
    op: z.literal("turn"),
    owner: ownerSchema,
    input: handleInput.extend({
      text: z.string(),
      mode: z.enum(["prompt", "steer"]),
      requestId: text,
      attachments: z.array(z.strictObject({ mediaType: text, data: z.string() })).optional(),
      elicitation: z.boolean().optional(),
      permissions: z.boolean().optional(),
    }),
  }),
  z.strictObject({ op: z.literal("status"), owner: ownerSchema, input: handleInput }),
  z.strictObject({ op: z.literal("capabilities"), owner: ownerSchema, input: handleInput }),
  z.strictObject({
    op: z.literal("setMode"),
    owner: ownerSchema,
    input: handleInput.extend({ mode: text }),
  }),
  z.strictObject({
    op: z.literal("setConfigOption"),
    owner: ownerSchema,
    input: handleInput.extend({ key: text, value: z.string() }),
  }),
  z.strictObject({
    op: z.literal("fresh"),
    owner: ownerSchema,
    input: ownerSchema.extend({ persistedHandle: handleSchema.optional() }),
  }),
  z.strictObject({
    op: z.literal("close"),
    owner: ownerSchema,
    input: handleInput.extend({
      reason: z.string(),
      discardPersistentState: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    op: z.literal("cancel"),
    owner: ownerSchema,
    input: handleInput.extend({ reason: z.string().optional() }),
  }),
]);
export type Request = z.infer<typeof requestSchema>;
/** A harness may not persist an empty session until its first prompt. */
export function retainsWorker(request: Request): boolean {
  return request.op === "ensure" || request.op === "setMode" || request.op === "setConfigOption";
}
export const envelopeSchema = z.strictObject({
  request: requestSchema,
  authorization: z.enum(["human-approved", "node-policy", "cancel-only"]),
});
export type ElicitationHandler = NonNullable<AcpRuntimeTurnInput["onElicitation"]>;
export type ElicitationRequest = Parameters<ElicitationHandler>[0];
export type ElicitationResponse = Awaited<ReturnType<ElicitationHandler>>;
export type PermissionHandler = NonNullable<AcpRuntimeTurnInput["onPermissionRequest"]>;
export type PermissionRequest = Parameters<PermissionHandler>[0];
// Permanent grants are intentionally not part of the remote transport.
export const permissionResponseSchema = z.strictObject({
  outcome: z.enum(["allow_once", "reject_once", "cancel"]),
});
export type PermissionResponse = z.infer<typeof permissionResponseSchema>;
const permissionRequestSchema = z
  .object({
    sessionId: text,
    inferredKind: z.string().optional(),
    raw: z
      .object({
        sessionId: text,
        toolCall: z
          .object({
            toolCallId: text,
            title: z.string().nullable().optional(),
            kind: z.string().nullable().optional(),
            rawInput: z.unknown().optional(),
            locations: z
              .array(z.object({ path: z.string(), line: z.number().nullable().optional() }))
              .nullable()
              .optional(),
          })
          .catchall(z.unknown()),
        options: z.array(
          z.object({ optionId: text, kind: text, name: z.string() }).catchall(z.unknown()),
        ),
      })
      .catchall(z.unknown()),
  })
  .transform((request) => ({ ...request, inferredKind: request.inferredKind }));
/** acpx otherwise falls back from allow_once to allow_always. Never widen a grant. */
export function permissionResponse(request: PermissionRequest, value: unknown): PermissionResponse {
  const parsed = permissionResponseSchema.safeParse(value);
  if (
    !parsed.success ||
    (parsed.data.outcome === "allow_once" &&
      !request.raw.options.some((option) => option.kind === "allow_once"))
  )
    return { outcome: "cancel" };
  return parsed.data;
}
const responseSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("accept"),
    content: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .nullable()
      .optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  z.strictObject({
    action: z.literal("decline"),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  z.strictObject({
    action: z.literal("cancel"),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
]);
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("cancel"), reason: z.string().optional() }),
  z.strictObject({ type: z.literal("elicitation_response"), id: text, response: responseSchema }),
  z.strictObject({
    type: z.literal("permission_response"),
    id: text,
    response: permissionResponseSchema,
  }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type WorkerStart = { type: "start"; request: Request; config: NodeConfig };
export type WorkerInput = WorkerStart | ClientMessage;
export type ServerMessage =
  | { type: "started" }
  | { type: "event"; event: AcpRuntimeEvent }
  | { type: "result"; result: AcpRuntimeTurnResult }
  | { type: "value"; value: unknown }
  | { type: "elicitation"; id: string; request: ElicitationRequest }
  | { type: "permission"; id: string; request: PermissionRequest }
  | { type: "error"; message: string; code?: string };

export function encodeMessage(value: unknown): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error("Remote ACP message exceeds 8 MiB");
  return bytes;
}
export function decodeMessage(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error("Remote ACP message exceeds 8 MiB");
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}
export function parseRequest(value: unknown): Request {
  const request = requestSchema.parse(value);
  const inputOwner = "handle" in request.input ? request.input.handle : request.input;
  if (
    inputOwner.sessionKey !== request.owner.sessionKey ||
    inputOwner.agentId !== request.owner.agentId
  ) {
    throw new Error("Remote ACP request owner does not match its session handle");
  }
  const persisted = "persistedHandle" in request.input ? request.input.persistedHandle : undefined;
  if (
    persisted &&
    (persisted.sessionKey !== request.owner.sessionKey ||
      persisted.agentId !== request.owner.agentId)
  ) {
    throw new Error("Remote ACP persisted handle belongs to another session owner");
  }
  return request;
}

const runtimeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text_delta"),
    text: z.string(),
    stream: z.enum(["output", "thought"]).optional(),
    tag: z.string().optional(),
  }),
  z.object({
    type: z.literal("status"),
    text: z.string(),
    tag: z.string().optional(),
    used: z.number().optional(),
    size: z.number().optional(),
  }),
  z.object({
    type: z.literal("tool_call"),
    text: z.string(),
    tag: z.string().optional(),
    toolCallId: z.string().optional(),
    status: z.string().optional(),
    title: z.string().optional(),
    kind: z
      .enum([
        "read",
        "edit",
        "delete",
        "move",
        "search",
        "execute",
        "fetch",
        "switch_mode",
        "think",
        "other",
      ])
      .optional(),
  }),
]);
export const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), stopReason: z.string().optional() }),
  z.object({ status: z.literal("cancelled"), stopReason: z.string().optional() }),
  z.object({
    status: z.literal("failed"),
    error: z.object({
      message: z.string(),
      code: z.string().optional(),
      detailCode: z.string().optional(),
      retryable: z.boolean().optional(),
    }),
  }),
]);
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started") }),
  z.strictObject({ type: z.literal("event"), event: runtimeEventSchema }),
  z.strictObject({ type: z.literal("result"), result: resultSchema }),
  z.strictObject({ type: z.literal("value"), value: z.unknown() }),
  z.strictObject({
    type: z.literal("elicitation"),
    id: text,
    request: z.object({ mode: z.string(), message: z.string() }).catchall(z.unknown()),
  }),
  z.strictObject({ type: z.literal("error"), message: z.string(), code: z.string().optional() }),
  z.strictObject({ type: z.literal("permission"), id: text, request: permissionRequestSchema }),
]);
