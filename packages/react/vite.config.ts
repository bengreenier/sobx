import { sobxCompiler } from "@sobx/compiler/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// compiled.spec.tsx is written against @sobx/magic; files that never mention it are skipped.
	plugins: [sobxCompiler()],
	build: {
		emptyOutDir: false, // preserve dist/types from tsc (build:types runs first)
		lib: {
			formats: ["es", "cjs"],
			entry: "src/index.ts",
			fileName: (format) => `react.${format === "es" ? "js" : "cjs"}`,
		},
		rollupOptions: {
			external: [/^react(\/.*)?$/, /^react-dom(\/.*)?$/, /^@sobx\/runtime$/],
		},
	},
	test: {
		globals: true,
		environment: "jsdom",
		include: ["src/**/*.spec.{ts,tsx}"],
		coverage: {
			provider: "istanbul",
		},
	},
});
