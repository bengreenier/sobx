import { defineConfig } from "vite";

export default defineConfig({
	build: {
		emptyOutDir: false, // preserve dist/types from tsc (build:types runs first)
		lib: {
			entry: "src/index.ts",
			formats: ["es", "cjs"],
			fileName: (format) =>
				format === "es" || format === "esm" ? "magic.js" : "magic.cjs",
		},
	},
});
