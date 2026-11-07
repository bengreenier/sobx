// Copy the cargo-built cdylib to `sobx-ast-native.node` so Node can load it.
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const name =
	process.platform === "win32"
		? "sobx_ast_native.dll"
		: process.platform === "darwin"
			? "libsobx_ast_native.dylib"
			: "libsobx_ast_native.so";
copyFileSync(
	path.join(root, "target", "release", name),
	path.join(root, "sobx-ast-native.node"),
);
console.log(`copied ${name} -> sobx-ast-native.node`);
