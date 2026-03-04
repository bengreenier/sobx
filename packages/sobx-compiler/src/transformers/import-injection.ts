import type { Program } from "@babel/types";
import type { Transformer } from "unplugin-ast";

const SOBX_IMPORT = 'import { ProxyLike } from "@sobx/core";';

/**
 * Transformer that never matches a node but runs finalize to inject @sobx/core import
 * when the transformed code uses ProxyLike.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function ImportInjectionTransformer(): Transformer<Program> {
	return {
		onNode(): boolean {
			return false; // never match; we only use finalize
		},

		transform(_node, _code, _context): undefined {
			return undefined; // never called (onNode always returns false)
		},

		finalize(s) {
			const code = s.toString();
			// Inject import if output uses ProxyLike and doesn't already have it
			if (
				(code.includes("new ProxyLike(") || code.includes("ProxyLike(")) &&
				!code.includes('from "@sobx/core"') &&
				!code.includes("from '@sobx/core'")
			) {
				s.appendLeft(0, SOBX_IMPORT + "\n");
			}
		},
	};
}
