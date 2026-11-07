// Feasibility probe for the TS-ESTree approach. Not part of the package.
import { analyze } from "@typescript-eslint/scope-manager";
import { parse as tsParse } from "@typescript-eslint/typescript-estree";
import { parseSync } from "oxc-parser";

const source = `
import { observable, makeObservable, action, reaction } from "sobx";
const store = observable({ count: 0, get double() { return this.count * 2 } });
function f(store) { return store.count; }
store.count = store.count + 1;
reaction(() => store.count, (n) => console.log(n));
class Legacy {
	@observable x = 0;
	constructor() { makeObservable(this); }
	@action inc() { this.x++; }
}
class Standard {
	@observable accessor y = 0;
}
type S = typeof store;
`;

function summarize(label, ast) {
	const manager = analyze(ast, { sourceType: "module" });
	const moduleScope = manager.scopes.find((s) => s.type === "module");
	const storeVar = moduleScope.set.get("store");
	const observableVar = moduleScope.set.get("observable");
	console.log(`\n== ${label}`);
	console.log(
		"program type:",
		ast.type,
		"| has parent on child:",
		!!ast.body[1]?.parent,
	);
	console.log(
		"store refs:",
		storeVar.references.map((r) => ({
			line: r.identifier.loc?.start.line ?? "(no loc)",
			write: r.isWrite(),
			typeRef: r.isTypeReference,
			valueRef: r.isValueReference,
		})),
	);
	console.log(
		"store defs:",
		storeVar.defs.map((d) => d.type),
	);
	console.log("observable refs:", observableVar.references.length);
	const inner = manager.scopes.find(
		(s) => s.type === "function" && s.block.id?.name === "f",
	);
	const innerStore = inner?.set.get("store");
	console.log("shadowing param 'store' refs:", innerStore?.references.length);
	const classScopes = manager.scopes
		.filter((s) => s.type === "class")
		.map((s) => s.block.id?.name);
	console.log("class scopes:", classScopes);
	const legacy = ast.body.find(
		(n) => n.type === "ClassDeclaration" && n.id.name === "Legacy",
	);
	const std = ast.body.find(
		(n) => n.type === "ClassDeclaration" && n.id.name === "Standard",
	);
	console.log(
		"Legacy members:",
		legacy.body.body.map(
			(m) => `${m.type}:${m.key?.name}:decorators=${m.decorators?.length ?? 0}`,
		),
	);
	console.log(
		"Standard members:",
		std.body.body.map(
			(m) => `${m.type}:${m.key?.name}:decorators=${m.decorators?.length ?? 0}`,
		),
	);
}

// 1. oxc-parser -> scope-manager
const oxc = parseSync("probe.ts", source, { range: true, lang: "ts" });
console.log(
	"oxc errors:",
	oxc.errors.length,
	oxc.errors.map((e) => e.message),
);
try {
	summarize("oxc-parser", oxc.program);
} catch (e) {
	console.log("oxc + scope-manager FAILED:", e.message);
}
console.log(
	"oxc staticImports:",
	JSON.stringify(
		oxc.module.staticImports.map((i) => ({
			from: i.moduleRequest.value,
			names: i.entries.map((e) => e.importName.name ?? e.importName.kind),
		})),
	),
);

// 2. typescript-estree (untyped) -> scope-manager
const ts = tsParse(source, { range: true, loc: true, jsx: false });
summarize("typescript-estree", ts);
