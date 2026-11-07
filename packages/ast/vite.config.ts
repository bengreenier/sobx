import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// When the Rust addon (packages/ast-native) is built, also run the analyzer specs against it.
const nativeShim = fileURLToPath(
	new URL("./src/__native__/analyze.ts", import.meta.url),
);
const hasNative = existsSync(
	fileURLToPath(new URL("../ast-native/sobx-ast-native.node", import.meta.url)),
);
// CI sets this so the parity checks can't pass by silently skipping.
if (process.env.SOBX_REQUIRE_NATIVE && !hasNative) {
	throw new Error(
		"SOBX_REQUIRE_NATIVE is set but packages/ast-native/sobx-ast-native.node is missing; run `pnpm --filter @sobx/ast-native build:native`.",
	);
}

export default defineConfig({
	build: {
		emptyOutDir: false, // preserve dist/types from tsc (build:types runs first)
		lib: {
			formats: ["es", "cjs"],
			entry: "src/index.ts",
		},
		rollupOptions: {
			external: ["@babel/parser", "@babel/traverse", "@babel/types"],
		},
	},
	test: {
		globals: true,
		coverage: {
			provider: "istanbul",
		},
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					include: ["**/*.spec.ts"],
					exclude: ["**/node_modules/**", "src/__native__/**"],
					environment: "node",
				},
			},
			...(hasNative
				? [
						{
							extends: true,
							resolve: {
								alias: [{ find: /^\.\/analyze\.js$/, replacement: nativeShim }],
							},
							test: {
								name: "native",
								include: ["src/analyze*.spec.ts", "src/__native__/*.spec.ts"],
								environment: "node",
							},
						},
					]
				: []),
			{
				extends: true,
				test: {
					name: "browser",
					include: ["**/*.test.ts"],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
	},
});
