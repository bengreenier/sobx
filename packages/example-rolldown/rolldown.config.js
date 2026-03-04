import { sobxCompiler } from "@sobx/compiler/rolldown";
import { defineConfig } from "rolldown";

export default defineConfig({
	input: "src/index.ts",
	output: {
		dir: "dist",
		entryFileNames: "index.js",
		format: "esm",
	},
	plugins: [sobxCompiler()],
});
