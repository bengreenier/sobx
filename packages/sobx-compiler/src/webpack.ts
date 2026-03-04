import AST from "unplugin-ast/webpack";
import type { WebpackPluginInstance } from "webpack";
import { createSobxCompiler, type SobxCompilerOptions } from "./core.js";

const compiler = createSobxCompiler(
	AST as import("./core.js").ASTPluginFactory,
);

/**
 * Webpack plugin. Use: plugins: [sobxCompiler()].
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function sobxCompiler(
	options: SobxCompilerOptions = {},
): WebpackPluginInstance {
	return compiler(options) as WebpackPluginInstance;
}

export type { SobxCompilerOptions };
