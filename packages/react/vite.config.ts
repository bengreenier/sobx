import { sobxCompiler } from "@sobx/compiler/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// Only the compiled specs are written against @sobx/magic (the others use @sobx/runtime
	// directly, to compare with MobX).
	plugins: [sobxCompiler({ include: /\.compiled\.spec\.tsx$/ })],
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
