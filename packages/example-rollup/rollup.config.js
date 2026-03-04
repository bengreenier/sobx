import typescript from "@rollup/plugin-typescript";
import { sobxCompiler } from "@sobx/compiler/rollup";

export default {
	input: "src/index.ts",
	output: {
		file: "dist/index.js",
		format: "esm",
	},
	plugins: [sobxCompiler(), typescript()],
};
