import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// The analyzer specs run against the Babel reference analyzer in test/ (not distributed).
// When the Rust addon is built (`pnpm --filter @sobx/compiler build:native`), they also run
// against it, through a shim that checks its output against the Babel analyzer.
const nativeShim = fileURLToPath(
	new URL("./test/native/analyze.ts", import.meta.url),
);
const hasNative = existsSync(
	fileURLToPath(new URL("../compiler/sobx-compiler.node", import.meta.url)),
);
// CI sets this so the parity checks can't pass by silently skipping.
if (process.env.SOBX_REQUIRE_NATIVE && !hasNative) {
	throw new Error(
		"SOBX_REQUIRE_NATIVE is set but packages/compiler/sobx-compiler.node is missing; run `pnpm --filter @sobx/compiler build:native`.",
	);
}

export default defineConfig({
	build: {
		emptyOutDir: false, // preserve dist/types from tsc (build:types runs first)
		lib: {
			formats: ["es", "cjs"],
			entry: "src/index.ts",
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
					exclude: ["**/node_modules/**", "test/native/**"],
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
								include: ["test/analyze*.spec.ts", "test/native/*.spec.ts"],
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
