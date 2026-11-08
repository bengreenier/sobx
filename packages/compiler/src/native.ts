import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SobxModule } from "@sobx/ast";

/** The napi addon built from `crates/sobx_compiler`. */
interface NativeBinding {
	analyze(source: string, moduleSpecifier?: string, filename?: string): string;
}

// This file is built to both ESM and CJS; the CJS build has no `import.meta.url`.
const here =
	typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
const require = createRequire(here);

/** napi-rs platform suffix for this process, e.g. `win32-x64-msvc` or `linux-x64-musl`. */
function platformSuffix(): string {
	const { platform, arch } = process;
	if (platform === "win32") return `win32-${arch}-msvc`;
	if (platform === "linux") {
		const report = process.report?.getReport() as
			| { header?: { glibcVersionRuntime?: string } }
			| undefined;
		const libc = report?.header?.glibcVersionRuntime ? "gnu" : "musl";
		return `linux-${arch}-${libc}`;
	}
	return `${platform}-${arch}`;
}

/**
 * Where the addon is looked for, in order:
 * 1. `SOBX_NATIVE_PATH`, if set.
 * 2. `sobx-compiler.node` in the package root, written by `pnpm build:native` (development).
 * 3. The prebuilt `@sobx/compiler-<platform>` package.
 */
function load(): NativeBinding {
	const override = process.env.SOBX_NATIVE_PATH;
	if (override) return require(override) as NativeBinding;

	// A path join rather than `new URL(..., import.meta.url)`, which Vite would inline as an asset.
	const local = path.join(path.dirname(here), "..", "sobx-compiler.node");
	if (existsSync(local)) return require(local) as NativeBinding;

	const pkg = `@sobx/compiler-${platformSuffix()}`;
	try {
		return require(pkg) as NativeBinding;
	} catch (error) {
		throw new Error(
			`sobx: could not load the native analyzer. Install ${pkg} (it should come with @sobx/compiler as an optional dependency), or build it from source with \`pnpm --filter @sobx/compiler build:native\`.`,
			{ cause: error },
		);
	}
}

let binding: NativeBinding | undefined;

export interface AnalyzeOptions {
	/** Module whose imports are analyzed. Default `"@sobx/magic"`. */
	moduleSpecifier?: string;
	/** Recorded on the resulting module. */
	filename?: string;
}

/**
 * Analyze a module's MobX-style usages with the native (Rust / oxc) analyzer and return its IR.
 * Throws on syntax errors.
 */
export function analyze(
	source: string,
	options: AnalyzeOptions = {},
): SobxModule {
	binding ??= load();
	return JSON.parse(
		binding.analyze(source, options.moduleSpecifier, options.filename),
	) as SobxModule;
}
