// Typed-mode probe: typescript-estree + project service + checker. Not part of the package.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAndGenerateServices } from "@typescript-eslint/typescript-estree";
import { visitorKeys } from "@typescript-eslint/visitor-keys";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "project");
const filePath = path.join(dir, "use.ts");
const code = readFileSync(filePath, "utf-8");

const t0 = performance.now();
const { ast, services } = parseAndGenerateServices(code, {
	filePath,
	projectService: true,
	tsconfigRootDir: dir,
	range: true,
	loc: true,
});
const t1 = performance.now();
const checker = services.program.getTypeChecker();
const toTs = (node) => services.esTreeNodeToTSNodeMap.get(node);

function walk(node, visit, parent = null) {
	visit(node, parent);
	for (const key of visitorKeys[node.type] ?? []) {
		const child = node[key];
		if (Array.isArray(child)) for (const c of child) c && walk(c, visit, node);
		else if (child && typeof child.type === "string") walk(child, visit, node);
	}
}

const where = (decl) =>
	decl
		? `${path.basename(decl.getSourceFile().fileName)}:${
				decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart())
					.line + 1
			} (${ts.SyntaxKind[decl.kind]})`
		: "(none)";

const ts = (await import("typescript")).default;

const isBranded = (type) =>
	checker
		.getPropertiesOfType(checker.getApparentType(type))
		.some((p) => String(p.escapedName).startsWith("__@OBSERVABLE"));

console.log(`typed parse: ${(t1 - t0).toFixed(0)}ms`);
walk(ast, (node) => {
	if (node.loc.start.line !== 10) return; // the console.log(...) line inside autorun
	if (
		(node.type === "CallExpression" &&
			node.callee.type !== "MemberExpression") ||
		(node.type === "CallExpression" && node.callee.property?.name !== "log")
	) {
		const sig = checker.getResolvedSignature(toTs(node));
		console.log(
			`call ${code.slice(node.range[0], node.range[1]).padEnd(16)} -> ${where(sig?.declaration)}`,
		);
	}
	if (
		node.type === "MemberExpression" &&
		node.object.type === "Identifier" &&
		node.object.name !== "console"
	) {
		const objType = checker.getTypeAtLocation(toTs(node.object));
		const sym = objType.getSymbol() ?? objType.aliasSymbol;
		const decl = sym?.declarations?.[0];
		console.log(
			`member ${code.slice(node.range[0], node.range[1]).padEnd(14)} branded=${isBranded(objType)} typeDecl=${where(decl)}`,
		);
	}
});
