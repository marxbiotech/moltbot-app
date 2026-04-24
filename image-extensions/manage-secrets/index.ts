import { setSecretTool } from "./src/set-secret.ts";
import { setConfigTool } from "./src/set-config.ts";

export default function register(api: any) {
  api.registerTool(setSecretTool);
  api.registerTool(setConfigTool);
}
