import * as esbuild from "esbuild";
import { sobxCompiler } from "@sobx/compiler/esbuild";

await esbuild.build({
	entryPoints: ["src/index.ts"],
	bundle: true,
	outfile: "dist/index.js",
	format: "esm",
	platform: "node",
	plugins: [sobxCompiler()],
});
