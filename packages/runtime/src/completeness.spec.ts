/**
 * Everything `mobx` exports, and every member of what it creates, exists here too, except what is
 * listed below with a reason.
 */
import * as mobx from "mobx";
import * as sobx from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: compared by name
type Any = any;

/** MobX exports that are deliberately not provided. */
const OMITTED: Record<string, string> = {
	__esModule: "module interop",
	default: "module interop",
	"module.exports": "module interop",
};

/** Members that are MobX's private implementation (not in its documentation or public types). */
const isPrivateMember = (name: string | symbol) =>
	typeof name === "symbol" ||
	name.endsWith("_") ||
	[
		// Annotation objects.
		"decorate_20223_",
		// Atom internals.
		"diffValue",
		"isBeingObserved",
		"isPendingUnobservation",
		"isMobXAtom",
		"onBO",
		"onBOL",
		"onBUO",
		"onBUOL",
		// Value internals.
		"dehanceValue",
		"dehancer",
		"derivation",
		"enhancer",
		"equals",
		"isComputing",
		"isMobXComputedValue",
		"isMobXObservableMap",
		"isMobXObservableSet",
		"isMobXObservableValue",
		"isRunningSetter",
		"isMobXReaction",
		"isDisposed",
		"isScheduled",
		"isTrackPending",
		"isRunning",
		"raw",
		"reportExceptionInDerivation",
		"trackAndCompute",
	].includes(name);

function members(value: Any): Set<string | symbol> {
	const names = new Set<string | symbol>();
	const stop = [Object, Array, Map, Set, Function].map((c) => c.prototype);
	for (let o = value; o && !stop.includes(o); o = Object.getPrototypeOf(o)) {
		for (const name of Reflect.ownKeys(o)) {
			if (!isPrivateMember(name) && !/^\d+$/.test(String(name))) {
				names.add(name);
			}
		}
	}
	return names;
}

describe("completeness", () => {
	it("has every export of mobx", () => {
		const missing = Object.keys(mobx).filter(
			(name) => !(name in sobx) && !(name in OMITTED),
		);
		expect(missing).toEqual([]);
	});

	it("has the members of functions that have some", () => {
		for (const name of Object.keys(mobx)) {
			const value = (mobx as Any)[name];
			if (typeof value !== "function" || !(name in sobx)) continue;
			const missing = Object.keys(value).filter(
				(m) => !isPrivateMember(m) && !(m in (sobx as Any)[name]),
			);
			expect([name, missing]).toEqual([name, []]);
		}
	});

	const makers: Record<string, (lib: Any) => Any> = {
		map: (lib) => lib.observable.map(),
		set: (lib) => lib.observable.set(),
		box: (lib) => lib.observable.box(1),
		computed: (lib) => lib.computed(() => 1),
		atom: (lib) => lib.createAtom?.("a") ?? {},
		reaction: (lib) => new lib.Reaction("r", () => {}),
		disposer: (lib) => lib.autorun(() => {}),
		flow: (lib) => lib.flow(function* () {})(),
		"when promise": (lib) => lib.when(() => true),
	};
	for (const [kind, make] of Object.entries(makers)) {
		it(`has every member of a ${kind}`, () => {
			const theirs = make(mobx);
			const ours = make(sobx);
			expect([...members(theirs)].filter((m) => !(m in ours))).toEqual([]);
		});
	}

	it("has the methods MobX adds to arrays", () => {
		// They come from the proxy, so they can't be listed.
		const added = [
			"clear",
			"replace",
			"remove",
			"spliceWithArray",
			"toJSON",
			...Object.getOwnPropertyNames(Array.prototype),
		];
		const theirs = mobx.observable([1]) as Any;
		const ours = sobx.observable([1]) as Any;
		expect(
			added.filter((m) => theirs[m] !== undefined && ours[m] === undefined),
		).toEqual([]);
	});
});
