import AST from "unplugin-ast/vite";
import type { Plugin } from "vite";
import { createSobxCompiler, type SobxCompilerOptions } from "./core.js";

const compiler = createSobxCompiler(
	AST as import("./core.js").ASTPluginFactory,
);

/**
 * Vite plugin that compiles MobX-style code (observable, direct property access, reaction)
 * to sobx-compatible code using unplugin-ast custom transformers.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function sobxCompiler(options: SobxCompilerOptions = {}): Plugin[] {
	return [compiler(options) as Plugin];
}

export type { SobxCompilerOptions } from "./core.js";
