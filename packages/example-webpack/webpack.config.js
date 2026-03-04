import path from "node:path";
import { fileURLToPath } from "node:url";
import { sobxCompiler } from "@sobx/compiler/webpack";

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
					loader: "ts-loader",
					options: { compilerOptions: { noEmit: false } },
				},
				exclude: /node_modules/,
			},
		],
	},
	plugins: [sobxCompiler()],
};
