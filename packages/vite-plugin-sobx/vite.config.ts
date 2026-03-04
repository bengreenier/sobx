import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		lib: {
			formats: ["es", "cjs"],
			entry: "src/index.ts",
		},
	},
	test: {
		globals: true,
		coverage: {
			provider: "istanbul",
		},
		browser: {
			enabled: true,
			headless: true,
			provider: playwright(),
			instances: [{ browser: "chromium" }],
		},
	},
});
