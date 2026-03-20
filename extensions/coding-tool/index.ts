import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerCodingTool } from "./src/tool.js";

const plugin = {
  id: "coding-tool",
  name: "Coding Tool",
  description: "LLM-invocable Claude Code via remote-acpx runtime.",
  register(api: OpenClawPluginApi) {
    registerCodingTool(api);
  },
};

export default plugin;
