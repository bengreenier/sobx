import type { DiagnosticsConfig } from "./diagnostics.js";
import { DEFAULT_MODULE_SPECIFIER } from "./transform.js";
import { PARSER_PLUGINS, SobxTransformer } from "./transformers/sobx.js";

const DEFAULT_INCLUDE = /\.[jt]sx?$/;
/** Skip dependency sources — Babel-parsing node_modules dominates bundler time. */
const DEFAULT_EXCLUDE = /node_modules/;

export interface SobxCompilerOptions {
	/**
	 * Include pattern for files to transform (default: /\.[jt]sx?$/).
	 */
	include?: string | RegExp | (string | RegExp)[];
	/**
	 * Exclude pattern(s) to skip. Always merged with `/node_modules/`.
	 */
	exclude?: string | RegExp | (string | RegExp)[];
	/**
	 * Module specifier to treat as sobx: its imports are redirected to `@sobx/runtime`. Default `"@sobx/magic"`.
	 */
	moduleSpecifier?: string;
	/**
	 * Per-code severity overrides for diagnostics (`"error"` fails the build, `"warning"` is
	 * logged, `"info"` / `"off"` are silent), e.g. `{ "deep-mutation": "warning" }`.
	 */
	diagnostics?: DiagnosticsConfig;
	/**
	 * Which modules to compile: `"all"` (default; property operations on observables passed to
	 * any of your modules are observed) or `"sobx"` (only modules importing `@sobx/magic` or
	 * `@sobx/react`: faster builds, other modules must use the explicit API). `node_modules` are
	 * excluded either way unless `include`d.
	 */
	modules?: "all" | "sobx";
}

export type ASTPluginFactory = (opts: {
	include?: RegExp;
	exclude?: string | RegExp | (string | RegExp)[];
	parserOptions?: { plugins?: unknown[] };
	transformer: unknown[];
}) => unknown;

function mergeExclude(
	exclude?: string | RegExp | (string | RegExp)[],
): string | RegExp | (string | RegExp)[] {
	if (exclude == null) return DEFAULT_EXCLUDE;
	const extras = Array.isArray(exclude) ? exclude : [exclude];
	return [...extras, DEFAULT_EXCLUDE];
}

/**
 * Creates the sobx compiler plugin for a given unplugin-ast bundler entry.
 * Use with unplugin-ast/vite, unplugin-ast/rollup, unplugin-ast/webpack, etc.
 */
export function createSobxCompiler(ast: ASTPluginFactory) {
	return function sobxCompiler(options: SobxCompilerOptions = {}) {
		const {
			include = DEFAULT_INCLUDE,
			exclude,
			moduleSpecifier = DEFAULT_MODULE_SPECIFIER,
			diagnostics,
			modules,
		} = options;
		return ast({
			include: include as RegExp,
			exclude: mergeExclude(exclude),
			parserOptions: { plugins: [...PARSER_PLUGINS] },
			transformer: [SobxTransformer({ moduleSpecifier, diagnostics, modules })],
		});
	};
}
