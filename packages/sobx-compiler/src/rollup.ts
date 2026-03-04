import type { Plugin } from "rollup";
import AST from "unplugin-ast/rollup";
import {
	createSobxCompiler,
	type SobxCompilerOptions,
} from "./core.js";

const compiler = createSobxCompiler(AST as import("./core.js").ASTPluginFactory);

/**
 * Rollup plugin. Use: plugins: [sobxCompiler()].
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function sobxCompiler(options: SobxCompilerOptions = {}): Plugin {
	return compiler(options) as Plugin;
}

export type { SobxCompilerOptions };
