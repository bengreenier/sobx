import AST from "unplugin-ast/rspack";
import {
	createSobxCompiler,
	type SobxCompilerOptions,
} from "./core.js";

const compiler = createSobxCompiler(AST as import("./core.js").ASTPluginFactory);

/** Rspack plugin instance (avoids hard dependency on rspack types). */
export type RspackPlugin = { apply: (compiler: unknown) => void };

/**
 * Rspack plugin. Use: plugins: [sobxCompiler()].
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function sobxCompiler(options: SobxCompilerOptions = {}): RspackPlugin {
	return compiler(options) as RspackPlugin;
}

export type { SobxCompilerOptions };
