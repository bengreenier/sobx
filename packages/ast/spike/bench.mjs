// SPIKE benchmark: parse + scope analysis cost, and warm typed-mode cost. Not part of the package.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as babelParse } from "@babel/parser";
import babelTraverse from "@babel/traverse";
import { analyze as analyzeScopes } from "@typescript-eslint/scope-manager";
import {
	parseAndGenerateServices,
	parse as tsParse,
} from "@typescript-eslint/typescript-estree";
import { parseSync } from "oxc-parser";

const traverse =
	typeof babelTraverse === "function" ? babelTraverse : babelTraverse.default;
const here = path.dirname(fileURLToPath(import.meta.url));
const bigFile = path.join(here, "..", "src", "analyze.ts");
const big = readFileSync(bigFile, "utf-8");

function median(fn, runs = 30, warmup = 5) {
	for (let i = 0; i < warmup; i++) fn();
	const times = [];
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		fn();
		times.push(performance.now() - t);
	}
	times.sort((a, b) => a - b);
	return times[Math.floor(times.length / 2)];
}

const fmt = (ms) => `${ms.toFixed(2)}ms`;
console.log(
	`untyped, ${big.split("\n").length} lines (${(big.length / 1024).toFixed(0)} KB):`,
);

const rows = {
	"babel parse": () =>
		babelParse(big, {
			sourceType: "module",
			plugins: ["typescript", "decorators"],
		}),
	"babel parse + scope crawl": () => {
		const file = babelParse(big, {
			sourceType: "module",
			plugins: ["typescript", "decorators"],
		});
		traverse(file, {
			Program(p) {
				p.stop();
			},
		});
	},
	"oxc parse": () =>
		parseSync("a.ts", big, { range: true, preserveParens: false }),
	"oxc parse + scope-manager": () => {
		const { program } = parseSync("a.ts", big, {
			range: true,
			preserveParens: false,
		});
		analyzeScopes(program, { sourceType: "module" });
	},
	"typescript-estree parse": () => tsParse(big, { range: true }),
	"typescript-estree parse + scope-manager": () => {
		analyzeScopes(tsParse(big, { range: true }), { sourceType: "module" });
	},
};
for (const [name, fn] of Object.entries(rows)) {
	console.log(`  ${name.padEnd(42)} ${fmt(median(fn))}`);
}

// Typed mode: cold first file, then warm subsequent files on the same project service.
const project = path.join(here, "project");
const typed = (file) => {
	const filePath = path.join(project, file);
	const t = performance.now();
	const { services } = parseAndGenerateServices(
		readFileSync(filePath, "utf-8"),
		{
			filePath,
			projectService: true,
			tsconfigRootDir: project,
			range: true,
		},
	);
	services.program.getTypeChecker();
	return performance.now() - t;
};
console.log("typed (project service, small project):");
console.log(`  cold  use.ts        ${fmt(typed("use.ts"))}`);
console.log(`  warm  selectors.ts  ${fmt(typed("selectors.ts"))}`);
console.log(`  warm  store.ts      ${fmt(typed("store.ts"))}`);
console.log(`  warm  use.ts again  ${fmt(typed("use.ts"))}`);
