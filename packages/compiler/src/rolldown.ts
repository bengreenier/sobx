import type { Plugin } from "rolldown";
import AST from "unplugin-ast/rolldown";
import { createSobxCompiler, type SobxCompilerOptions } from "./core.js";

const compiler = createSobxCompiler(
	AST as import("./core.js").ASTPluginFactory,
);

/**
 * Rolldown / tsdown plugin. Use: plugins: [sobxCompiler()].
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function sobxCompiler(options: SobxCompilerOptions = {}): Plugin {
	return compiler(options) as Plugin;
}

export type { SobxCompilerOptions };
