import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import generate from "@babel/generator";
import { transformSobx } from "./transform.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "__fixtures__");

function compile(source: string): string {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
	});
	const { ast: transformed } = transformSobx(ast.program);
	return generate(transformed).code;
}

function loadFixture(name: string, kind: "input" | "output" = "input"): string {
	const ext = kind === "input" ? "input.ts" : "output.ts";
	const filePath = path.join(FIXTURES_DIR, `${name}.${ext}`);
	return readFileSync(filePath, "utf-8");
}

describe("transformSobx", () => {
	it("observable: compiles observable() to new ProxyLike() and adds import", () => {
		const input = loadFixture("observable");
		const expected = loadFixture("observable", "output");
		const output = compile(input);
		expect(output.trim()).toBe(expected.trim());
	});

	it("property-read: compiles state.count to state.get(\"count\")", () => {
		const input = loadFixture("property-read");
		const expected = loadFixture("property-read", "output");
		const output = compile(input);
		expect(output.trim()).toBe(expected.trim());
	});

	it("property-write: compiles state.count = 1 to state.set(\"count\", 1)", () => {
		const input = loadFixture("property-write");
		const expected = loadFixture("property-write", "output");
		const output = compile(input);
		expect(output.trim()).toBe(expected.trim());
	});

	it("reaction: compiles reaction() to addObserver + initial effect", () => {
		const input = loadFixture("reaction");
		const expected = loadFixture("reaction", "output");
		const output = compile(input);
		expect(output.trim()).toBe(expected.trim());
	});

	it("combined: observable + reads + writes + reaction in one file", () => {
		const input = loadFixture("combined");
		const expected = loadFixture("combined", "output");
		const output = compile(input);
		expect(output.trim()).toBe(expected.trim());
	});

	// MobX-style examples (zero-dependency patterns from MobX docs)
	it("mobx-counter: observable + reaction + increment", () => {
		const input = loadFixture("mobx-counter");
		const expected = loadFixture("mobx-counter", "output");
		const output = compile(input);
		expect(output.trim()).toBe(expected.trim());
	});

	it("mobx-multiple-reactions: one store, multiple reactions", () => {
		const input = loadFixture("mobx-multiple-reactions");
		const expected = loadFixture("mobx-multiple-reactions", "output");
		const output = compile(input);
		expect(output.trim()).toBe(expected.trim());
	});

	it("mobx-sync-effect: reaction as sync to external system", () => {
		const input = loadFixture("mobx-sync-effect");
		const expected = loadFixture("mobx-sync-effect", "output");
		const output = compile(input);
		expect(output.trim()).toBe(expected.trim());
	});
});
