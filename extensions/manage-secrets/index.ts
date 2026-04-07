import { setSecretTool } from "./src/set-secret.ts";

export default function register(api: any) {
  api.registerTool(setSecretTool);
}
