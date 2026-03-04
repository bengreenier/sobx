import path from "node:path";
import { fileURLToPath } from "node:url";
import rspack from "@rspack/core";
import { sobxCompiler } from "@sobx/compiler/rspack";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
	mode: "production",
	entry: "./src/index.ts",
	output: {
		path: path.join(__dirname, "dist"),
		filename: "index.js",
		module: true,
	},
	experiments: {
		outputModule: true,
	},
	resolve: {
		extensionAlias: { ".js": [".ts", ".js"] },
		extensions: [".ts", ".js"],
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				use: {
					loader: "builtin:swc-loader",
					options: {
						jsc: {
							parser: { syntax: "typescript" },
						},
					},
				},
				exclude: /node_modules/,
			},
		],
	},
	plugins: [sobxCompiler()],
};
