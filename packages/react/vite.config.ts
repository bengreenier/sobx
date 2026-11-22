import path from "node:path";
import { fileURLToPath } from "node:url";
import { sobxCompiler } from "@sobx/compiler/vite";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
/** React 18, and the libraries the tests use with React, installed against it. */
const react18 = path.join(here, "test/react18/node_modules");

export default defineConfig({
	// Only the compiled specs (and the modules they use) are written against @sobx/magic; the
	// other specs use @sobx/runtime directly, to compare with MobX.
	plugins: [sobxCompiler({ include: /\.compiled(\.spec)?\.tsx?$/ })],
	// The compiled specs import the package by name, as applications do.
	resolve: {
		alias: [
			{ find: /^@sobx\/react$/, replacement: path.join(here, "src/index.ts") },
		],
	},
	build: {
		emptyOutDir: false, // preserve dist/types from tsc (build:types runs first)
		lib: {
			formats: ["es", "cjs"],
			entry: "src/index.ts",
			fileName: (format) => `react.${format === "es" ? "js" : "cjs"}`,
		},
		rollupOptions: {
			external: [/^react(\/.*)?$/, /^react-dom(\/.*)?$/, /^@sobx\/runtime$/],
		},
	},
	test: {
		globals: true,
		environment: "jsdom",
		include: ["src/**/*.spec.{ts,tsx}"],
		coverage: {
			provider: "istanbul",
		},
		projects: [
			{ extends: true, test: { name: "react19", env: { REACT_MAJOR: "19" } } },
			{
				extends: true,
				test: {
					name: "react18",
					env: { REACT_MAJOR: "18" },
					setupFiles: ["test/no-finalization-registry.ts"],
				},
				resolve: {
					alias: [
						{
							find: /^(react|react-dom|mobx|mobx-react|@testing-library\/react)(\/.*)?$/,
							replacement: `${react18.replaceAll("\\", "/")}/$1$2`,
						},
					],
				},
			},
		],
	},
});
