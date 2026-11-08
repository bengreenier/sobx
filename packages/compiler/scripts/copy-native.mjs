// Copy the cargo-built cdylib (crates/sobx_compiler) to `sobx-compiler.node` so Node can load it.
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const name =
	process.platform === "win32"
		? "sobx_compiler.dll"
		: process.platform === "darwin"
			? "libsobx_compiler.dylib"
			: "libsobx_compiler.so";
copyFileSync(
	path.join(pkg, "..", "..", "target", "release", name),
	path.join(pkg, "sobx-compiler.node"),
);
console.log(`copied ${name} -> packages/compiler/sobx-compiler.node`);
