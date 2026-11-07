// SPIKE benchmark: typed-mode cost including actual checker queries. Not part of the package.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAndGenerateServices } from "@typescript-eslint/typescript-estree";
import { visitorKeys } from "@typescript-eslint/visitor-keys";

const project = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"project",
);

function walk(node, visit) {
	visit(node);
	for (const key of visitorKeys[node.type] ?? []) {
		const child = node[key];
		if (Array.isArray(child)) for (const c of child) c && walk(c, visit);
		else if (child && typeof child.type === "string") walk(child, visit);
	}
}

/** Parse with types, then resolve every call and the type of every member receiver. */
function run(file) {
	const filePath = path.join(project, file);
	const t0 = performance.now();
	const { ast, services } = parseAndGenerateServices(
		readFileSync(filePath, "utf-8"),
		{ filePath, projectService: true, tsconfigRootDir: project, range: true },
	);
	const t1 = performance.now();
	const checker = services.program.getTypeChecker();
	let queries = 0;
	walk(ast, (node) => {
		const tsNode = services.esTreeNodeToTSNodeMap.get(node);
		if (node.type === "CallExpression") {
			checker.getResolvedSignature(tsNode);
			queries++;
		} else if (node.type === "MemberExpression") {
			checker.getTypeAtLocation(
				services.esTreeNodeToTSNodeMap.get(node.object),
			);
			queries++;
		}
	});
	const t2 = performance.now();
	console.log(
		`  ${file.padEnd(14)} parse+program ${(t1 - t0).toFixed(1)}ms, ${queries} queries ${(t2 - t1).toFixed(1)}ms`,
	);
}

console.log("typed, in order (first is cold):");
run("use.ts");
run("selectors.ts");
run("store.ts");
run("use.ts");
