import { defineConfig } from "vite";

// Types only (plus IR_VERSION); the analyzer and its tests live in @sobx/compiler.
export default defineConfig({
	build: {
		emptyOutDir: false, // preserve dist/types from tsc (build:types runs first)
		lib: {
			formats: ["es", "cjs"],
			entry: "src/index.ts",
		},
	},
});
