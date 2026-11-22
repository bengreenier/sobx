/**
 * Differences found by running MobX's own test suite against this runtime: each scenario must log
 * the same with both.
 */
import * as mobx from "mobx";
import * as sobx from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript on purpose
type Any = any;
type Log = (...values: unknown[]) => void;
type Scenario = (api: Any, log: Log) => void | Promise<void>;

async function run(scenario: Scenario, api: Any): Promise<unknown[]> {
	const logs: unknown[] = [];
	const spies = (["warn", "error"] as const).map((level) =>
		vi.spyOn(console, level).mockImplementation(() => {
			logs.push(`console.${level}`);
		}),
	);
	try {
		await scenario(api, (...values) => {
			for (const value of values) {
				logs.push(JSON.parse(JSON.stringify(value ?? null)));
			}
		});
	} finally {
		for (const spy of spies) spy.mockRestore();
		api._resetGlobalState();
		api.configure({ useProxies: proxies ? "always" : "never" });
	}
	return logs;
}

const proxies = !process.env.SOBX_NO_PROXIES;

function parity(name: string, scenario: Scenario, needsProxies = false) {
	it.skipIf(needsProxies && !proxies)(name, async () => {
		const theirs = await run(scenario, mobx);
		expect(theirs.length).toBeGreaterThan(0);
		expect(await run(scenario, sobx)).toEqual(theirs);
	});
}

const throws = (fn: () => unknown) => {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
};

beforeEach(() => {
	mobx.configure({ enforceActions: "never" });
	sobx.configure({ enforceActions: "never" });
});

parity("changes made while a dependency is first read", (api, log) => {
	const a = api.observable.box(0);
	const b = api.observable.box(0);
	const c = api.computed(() => a.get() + b.get());
	api.autorun(() => {
		log(c.get());
		b.set(100);
	});
	a.set(1);
});

parity("keepAlive computeds observe their dependencies", (api, log) => {
	const o = api.observable.box(1);
	const inner = api.computed(() => o.get());
	const kept = api.computed(() => inner.get() * 2, { keepAlive: true });
	api.onBecomeObserved(o, () => log("o observed"));
	api.onBecomeObserved(inner, () => log("inner observed"));
	kept.get();
	log("end");
});

parity("cycles found while updating", (api, log) => {
	const z = api.observable.box(true);
	const a: Any = api.computed(() => (z.get() ? 1 : b.get() * 2));
	const b: Any = api.computed(() => a.get() * 2);
	api.observe(b, () => {});
	log(a.get());
	z.set(false);
	z.set(true);
	log(a.get());
});

parity("comparers", (api, log) => {
	const { structural, shallow } = api.comparer;
	const day = () => new Date("2016-01-01");
	log(structural(day(), day()), structural(day(), new Date(0)));
	log(structural(/a/g, /a/g), structural(Number.NaN, Number.NaN));
	log(structural(0, -0), structural({ a: [{ b: 1 }] }, { a: [{ b: 1 }] }));
	const set = api.observable.set([1, { z: 1 }]);
	log(structural(new Set([1, { z: 1 }]), set));
	const map = api.observable.map({ a: { x: 1 } });
	log(structural(new Map([["a", { x: 1 }]]), map));
	const values: Array<() => unknown> = [
		() => ({}),
		() => [],
		() => new Set(),
		() => new Map(),
		() => api.observable({}),
		() => api.observable([]),
		() => api.observable.set(),
		() => api.observable.map(),
	];
	log(values.map((x) => values.map((y) => shallow(x(), y()))));
	log(shallow({ a: {} }, { a: {} }), shallow([1], [1]));
	log(shallow(new Set([1]), new Set([1])));
	log(shallow(new Set([1]), new Set([2])));
});

parity("observable() of other values", (api, log) => {
	const instance = new (class {})();
	log(api.observable(instance) === instance);
	log(api.isBoxedObservable(api.observable("x")), api.observable(5).get());
	const date = new Date();
	log(api.observable(date) === date);
});

parity("invalid uses", (api, log) => {
	log(throws(() => api.observable({ x: 1 }, { x: undefined })));
	log(throws(() => api.autorun(api.action(() => {}))));
	log(throws(() => api.autorun(1)));
	log(
		throws(() =>
			api.reaction(
				() => 1,
				() => {},
				() => {},
			),
		),
	);
	log(throws(() => api.toJS({}, { recurseEverything: true })));
	class MyMap extends Map {}
	log(throws(() => api.observable.map(new MyMap())));
	log(throws(() => api.observable.set([1]).replace("ab")));
	const struct = api.observable({ x: [1] }, { x: api.observable.struct });
	log(
		throws(() => {
			struct.x = api.observable([1]);
		}),
	);
	const named = api.makeObservable({}, {}, { name: "o" });
	log(throws(() => api.extendObservable(named, { x: 1 }, {}, {})));
	class Extended extends api.ObservableMap {
		x = 1;
		constructor() {
			super();
			api.makeObservable(this, { x: api.observable });
		}
	}
	log(throws(() => new Extended()));
	const first = api._startAction("first");
	const second = api._startAction("second");
	log(throws(() => api._endAction(first)));
	api._endAction(second);
	api._endAction(first);
	log(throws(() => api._endAction(first)));
});

parity("toString and the like as properties", (api, log) => {
	const o = api.observable({ toString: "a", valueOf: 1, constructor: 2 });
	log(o.toString, o.valueOf, o.constructor);
});

parity("compareStructural", (api, log) => {
	const x = api.observable.box(1);
	const c = api.computed(() => ({ odd: x.get() % 2 }), {
		compareStructural: true,
	});
	let runs = 0;
	api.autorun(() => {
		c.get();
		runs++;
	});
	x.set(3);
	x.set(4);
	log(runs);
});

parity("set() on arrays is batched", (api, log) => {
	const a = api.observable.array();
	api.reaction(
		() => api.values(a),
		(v: unknown) => log(v),
	);
	api.set(a, 0, 1);
	api.set(a, 3, 4);
	api.remove(a, 2);
});

parity("merge reads its source tracked", (api, log) => {
	const x = api.observable.map({ a: 1 });
	const y = api.observable.map({ b: 1 });
	let runs = 0;
	api.autorun(() => {
		runs++;
		x.merge(y);
	});
	y.set("c", 2);
	x.set("d", 3);
	log(runs, [...x.keys()]);
});

parity("toJS", (api, log) => {
	const key = Symbol("key");
	const o = api.observable({ [key]: 42, a: { b: 1 }, f() {} });
	const js = api.toJS(o);
	log(js[key], typeof js.f, api.isObservable(js.a));
	const c = api.observable({ c: api.computed(() => 5) });
	log(api.toJS(c).c);
	const plain = { list: api.observable([1]) };
	log(api.toJS(plain) === plain, api.isObservable(api.toJS(plain).list));
});

parity("isObservable of disposers", (api, log) => {
	log(
		api.isObservable(api.autorun(() => {})),
		api.isObservable(() => {}),
	);
});

parity("_interceptReads", (api, log) => {
	const a = api.observable([1, 2, 3, 4]);
	const stop = api._interceptReads(a, (v: number) => v * 10);
	log(a.slice(), a.indexOf(20), [...a], a.join());
	log(a.map((x: number) => x));
	log(api.get(a, 1), a.pop(), a.splice(0, 1), a.remove(20));
	stop();
	log(a.slice());
	const m = api.observable.map({ a: 1 });
	api._interceptReads(m, (v: number) => v + 1);
	log(m.get("a"), [...m.values()], [...m.entries()]);
	const b = api.observable.box(1);
	api._interceptReads(b, (v: number) => -v);
	log(b.get());
	const o = api.observable({ x: 1 });
	api._interceptReads(o, "x", (v: number) => `${v}!`);
	log(o.x);
	log(throws(() => api._interceptReads(o, "x", () => 1)));
	log(throws(() => api._interceptReads(o, () => 1)));
});

parity(
	"_interceptReads on array indexes",
	(api, log) => {
		const a = api.observable([1, 2]);
		api._interceptReads(a, (v: number) => v * 10);
		log(a[0], a[1], a.length);
	},
	true,
);

parity("spies: flow steps and computeds", async (api, log) => {
	const x = api.observable.box(1);
	const c = api.computed(() => x.get() > 1, { name: "c" });
	api.autorun(() => c.get(), { name: "run" });
	const stop = api.spy((e: Any) => {
		if (e.type === "action") log(e.arguments);
		if (e.observableKind === "computed") log(e.newValue, e.oldValue);
	});
	x.set(2);
	x.set(3);
	await api.flow(function* (): Any {
		yield Promise.resolve(5);
		try {
			yield Promise.reject("no");
		} catch {}
	})(7);
	stop();
});

it("a reaction knows whether it's scheduled", () => {
	const r = new sobx.Reaction("r", function () {
		this.track(() => {});
	});
	const seen = [r.isScheduled];
	sobx.runInAction(() => {
		r.schedule();
		seen.push(r.isScheduled);
	});
	seen.push(r.isScheduled);
	expect(seen).toEqual([false, true, false]);
});

it("Maps and Sets keep nothing of keys that are no longer observed", () => {
	const m = sobx.observable.map<string, number>({ a: 1 });
	const s = sobx.observable.set<string>(["a"]);
	const kept = (o: Any, field: string) => o[field]?.size ?? 0;
	for (let i = 0; i < 10; i++) {
		const stop = sobx.autorun(() => {
			m.get(`k${i}`);
			m.has(`k${i}`);
			s.has(`k${i}`);
		});
		stop();
	}
	expect(kept(m, "keyDeps")).toBe(0);
	expect(kept(m, "hasDeps")).toBe(0);
	expect(kept(s, "valueDeps")).toBe(0);
	// ...but listeners stay.
	let observed = 0;
	sobx.onBecomeObserved(m, "a", () => observed++);
	sobx.autorun(() => m.get("a"))();
	sobx.autorun(() => m.get("a"))();
	expect(observed).toBe(2);
});

// Last: MobX never stops checking.
parity(
	'useProxies: "ifavailable"',
	(api, log) => {
		api.configure({ useProxies: "ifavailable" });
		const o = api.observable({ z: 0 });
		log(
			throws(() => {
				o.y = 1;
			}),
			throws(() => {
				delete o.z;
			}),
		);
		api.autorun(() =>
			log(
				throws(() => "z" in o),
				throws(() => Object.keys(o)),
			),
		);
	},
	true,
);
