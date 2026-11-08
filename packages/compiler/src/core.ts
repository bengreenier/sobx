import { DEFAULT_MODULE_SPECIFIER } from "./transform.js";
import { SobxTransformer } from "./transformers/sobx.js";

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
	 * Module specifier to treat as sobx (only transform when imported from here). Default `"@sobx/magic"`.
	 */
	moduleSpecifier?: string;
}

export type ASTPluginFactory = (opts: {
	include?: RegExp;
	exclude?: string | RegExp | (string | RegExp)[];
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
		} = options;
		return ast({
			include: include as RegExp,
			exclude: mergeExclude(exclude),
			transformer: [SobxTransformer(moduleSpecifier)],
		});
	};
}
