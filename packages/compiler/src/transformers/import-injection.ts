import type { Transformer } from "unplugin-ast";

const SOBX_IMPORT = 'import { ProxyLike } from "@sobx/core";';

/**
 * Transformer that never matches a node but runs finalize to inject @sobx/core import
 * when the transformed code uses ProxyLike.
 * @see https://unplugin.unjs.io/showcase/unplugin-ast.html#custom-transformers
 */
export function ImportInjectionTransformer() {
	return {
		onNode(): boolean {
			return false; // never match; we only use finalize
		},

		transform(
			_node: unknown,
			_code: string,
			_context: { id: string },
		): undefined {
			return undefined; // never called (onNode always returns false)
		},

		finalize(s: {
			toString(): string;
			appendLeft(index: number, str: string): void;
		}) {
			const code = s.toString();
			// Inject import if output uses ProxyLike and doesn't already have it
			if (
				(code.includes("new ProxyLike(") || code.includes("ProxyLike(")) &&
				!code.includes('from "@sobx/core"') &&
				!code.includes("from '@sobx/core'")
			) {
				s.appendLeft(0, `${SOBX_IMPORT}\n`);
			}
		},
		// biome-ignore lint/suspicious/noExplicitAny: unplugin-ast expects babel 8 Node; we use babel 7, cast required
	} as Transformer<any>;
}
