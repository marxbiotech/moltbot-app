import { defineConfig } from "vite"
import { execSync } from "node:child_process"
import react from "@vitejs/plugin-react"
import { cloudflare } from "@cloudflare/vite-plugin"

function getBuildVersion(): string {
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
	} catch {
		return "unknown"
	}
}

export default defineConfig({
	base: "/_admin/",
	define: {
		__BUILD_VERSION__: JSON.stringify(getBuildVersion()),
	},
	plugins: [
		react(),
		cloudflare({
			configPath: "./wrangler.jsonc",
			persistState: false,
		}),
	],
})
