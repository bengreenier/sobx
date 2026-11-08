import { sobxCompiler } from "@sobx/compiler/esbuild";
import * as esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/index.ts"],
	bundle: true,
	outfile: "dist/index.js",
	format: "esm",
	platform: "node",
	// Lower standard decorators (Node does not run them natively yet).
	target: "es2022",
	plugins: [sobxCompiler()],
});
