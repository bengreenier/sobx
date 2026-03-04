import { defineConfig } from "rolldown";
import { sobxCompiler } from "@sobx/compiler/rolldown";

export default defineConfig({
	input: "src/index.ts",
	output: {
		dir: "dist",
		entryFileNames: "index.js",
		format: "esm",
	},
	plugins: [sobxCompiler()],
});
