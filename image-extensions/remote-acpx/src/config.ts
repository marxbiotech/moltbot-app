import path from "node:path";
import { z } from "zod";

const absolutePath = z.string().min(1).refine(path.isAbsolute, "Use an absolute node-local path");
const targetSchema = z.strictObject({ nodeId: z.string().min(1), cwd: absolutePath.optional() });
export const configSchema = z.strictObject({
  target: targetSchema.optional(),
  targets: z.record(z.string().min(1), targetSchema).default({}),
  node: z
    .strictObject({
      cwd: absolutePath,
      stateDir: absolutePath,
      agents: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({}),
      permissionMode: z.enum(["approve-all", "approve-reads", "deny-all"]).default("approve-reads"),
    })
    .optional(),
});
export type Config = z.infer<typeof configSchema>;
export type NodeConfig = NonNullable<Config["node"]>;
export type Target = NonNullable<Config["target"]>;
export function parseConfig(value: unknown): Config {
  return configSchema.parse(value ?? {});
}
