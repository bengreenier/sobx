import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	build: {
		emptyOutDir: false, // preserve dist/types from tsc (build:types runs first)
		lib: {
			formats: ["es", "cjs"],
			entry: {
				index: "src/index.ts",
				core: "src/core.ts",
				vite: "src/vite.ts",
				rollup: "src/rollup.ts",
				webpack: "src/webpack.ts",
				esbuild: "src/esbuild.ts",
				rolldown: "src/rolldown.ts",
				rspack: "src/rspack.ts",
			},
			fileName: (format, entryName) =>
				entryName + (format === "es" || format === "esm" ? ".js" : ".cjs"),
		},
		rollupOptions: {
			external: [
				/^node:/,
				"@sobx/ast",
				"@sobx/runtime",
				"unplugin",
				"unplugin-ast",
				"unplugin-ast/vite",
				"unplugin-ast/rollup",
				"unplugin-ast/webpack",
				"unplugin-ast/esbuild",
				"unplugin-ast/rolldown",
				"unplugin-ast/rspack",
				"vite",
				"rollup",
				"webpack",
				"esbuild",
				"rolldown",
				"rspack",
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
