import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		lib: {
			formats: ["es", "cjs"],
			entry: "src/index.ts",
			fileName: (format) => (format === "es" ? "index.js" : "index.cjs"),
		},
		rollupOptions: {
			external: [
				"@sobx/core",
				"unplugin",
				"unplugin-ast",
				"unplugin-ast/vite",
			],
		},
	},
	test: {
		globals: true,
		coverage: {
			provider: "istanbul",
		},
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					include: ["**/*.spec.ts"],
					environment: "node",
				},
			},
			{
				extends: true,
				test: {
					name: "browser",
					include: ["**/*.test.ts"],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
	},
});
