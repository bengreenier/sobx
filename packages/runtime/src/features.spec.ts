/**
 * MobX's less common features, each scenario run against `mobx` and `@sobx/runtime`: what it logs
 * (change objects, spy events, names, warnings...) must match.
 */
import * as mobx from "mobx";
import * as sobx from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript on purpose
type Any = any;
type Log = (...values: unknown[]) => void;
type Scenario = (api: Any, log: Log) => void | Promise<void>;

/** Ids differ between the libraries; values are compared as plain data. */
function normalize(
	api: Any,
	value: unknown,
	ids: Map<string, string>,
	depth = 0,
): unknown {
	if (typeof value === "string") {
		return value
			.replace(/\[(?:mobx|sobx|MobX)([^\]]*)\]/g, "[lib$1]")
			.replace(/@(\d+)/g, (_, id: string) => {
				if (!ids.has(id)) ids.set(id, `@#${ids.size + 1}`);
				return ids.get(id) as string;
			});
	}
	if (typeof value === "function") return "function";
	if (typeof value !== "object" || value === null) return value;
	if (value instanceof Error) return `Error: ${value.message}`;
	if (depth > 6) return "...";
	const each = (v: unknown) => normalize(api, v, ids, depth + 1);
	if (api.isObservableMap(value)) {
		return { map: [...(value as Map<unknown, unknown>)].map(each) };
	}
	if (api.isObservableSet(value)) {
		return { set: [...(value as Set<unknown>)].map(each) };
	}
	if (api.isBoxedObservable(value)) return { box: each((value as Any).get()) };
	if (api.isComputed(value)) return "computed";
	if (Array.isArray(value)) return [...value].map(each);
	if (value instanceof Map) return { map: [...value].map(each) };
	if (Object.getPrototypeOf(value)?.constructor?.name === "Reaction") {
		return "reaction";
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		out[key] = each((value as Record<string, unknown>)[key]);
	}
	return out;
}

async function run(scenario: Scenario, api: Any): Promise<unknown[]> {
	const logs: unknown[] = [];
	const ids = new Map<string, string>();
	const log: Log = (...values) => {
		for (const value of values) {
			logs.push(api.untracked(() => normalize(api, value, ids)));
		}
	};
	const spies = (["warn", "error", "log"] as const).map((level) =>
		vi.spyOn(console, level).mockImplementation((...args) => {
			// Wording differs: which messages there are, and what about, must match.
			logs.push(`console.${level} ${args.length}`);
		}),
	);
	try {
		await scenario(api, log);
	} catch (error) {
		logs.push("scenario threw", `${(error as Error)?.stack}`.slice(0, 0));
	} finally {
		for (const spy of spies) spy.mockRestore();
		api._resetGlobalState();
	}
	return logs;
}

function parity(name: string, scenario: Scenario) {
	it(name, async () => {
		const theirs = await run(scenario, mobx);
		expect(theirs).not.toContain("scenario threw");
		expect(theirs.length).toBeGreaterThan(0);
		expect(await run(scenario, sobx)).toEqual(theirs);
	});
}

/** What `fn` throws, as whether it throws. */
const throws = (fn: () => unknown) => {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
};

const proxied = it.skipIf(process.env.SOBX_NO_PROXIES);
function proxyParity(name: string, scenario: Scenario) {
	proxied(name, async () => {
		const theirs = await run(scenario, mobx);
		expect(theirs).not.toContain("scenario threw");
		expect(await run(scenario, sobx)).toEqual(theirs);
	});
}

beforeEach(() => {
	mobx.configure({ enforceActions: "never" });
	sobx.configure({ enforceActions: "never" });
});
afterEach(() => {
	mobx.configure({ enforceActions: "observed" });
	sobx.configure({ enforceActions: "observed" });
});

describe("computeds", () => {
	parity("cached in batches, not outside", (api, log) => {
		const o = api.observable.box(1);
		let runs = 0;
		const c = api.computed(() => {
			runs++;
			return o.get() * 2;
		});
		log(c.get(), c.get(), runs);
		api.runInAction(() => {
			log(c.get(), c.get(), runs);
			o.set(2);
			log(c.get(), c.get(), runs);
		});
		log(c.get(), runs);
	});

	parity("keepAlive", (api, log) => {
		const o = api.observable.box(1);
		let runs = 0;
		const c = api.computed(
			() => {
				runs++;
				return o.get();
			},
			{ keepAlive: true },
		);
		log(c.get(), c.get(), runs);
		o.set(2);
		log(runs, c.get(), c.get(), runs);
		const stop = api.autorun(() => log("run", c.get()));
		stop();
		log(c.get(), runs);
	});

	parity("not recomputed when re-observed in the same batch", (api, log) => {
		const o = api.observable.box(1);
		let runs = 0;
		const c = api.computed(() => {
			runs++;
			return o.get();
		});
		let stop = api.autorun(() => c.get());
		api.runInAction(() => {
			stop();
			stop = api.autorun(() => c.get());
		});
		log(runs);
		stop();
		log(c.get(), runs);
	});

	parity("set, context, errors, toPrimitive", (api, log) => {
		const o = api.observable.box(1);
		const c = api.computed(() => o.get() * 2, {
			set: (v: number) => o.set(v / 2),
			name: "double",
		});
		log(+c, `${c}`, String(c), c + 1);
		c.set(10);
		log(o.get(), c.get());
		log(throws(() => api.computed(() => 1).set(2)));
		log(throws(() => api.computed(1)));
		const ctx = { x: 5 };
		const withContext = api.computed(
			function (this: typeof ctx) {
				return this.x;
			},
			{ context: ctx },
		);
		log(withContext.get());
		const a: Any = api.computed(() => b.get());
		const b: Any = api.computed(() => a.get());
		log(throws(() => a.get()));
	});

	parity("computed setters on objects and classes", (api, log) => {
		const o = api.observable({
			n: 1,
			get double() {
				return this.n * 2;
			},
			set double(v: number) {
				this.n = v / 2;
			},
		});
		o.double = 8;
		log(o.n, o.double);
		class C {
			n = 1;
			constructor() {
				api.makeAutoObservable(this);
			}
			get twice() {
				return this.n * 2;
			}
			set twice(v: number) {
				this.n = v / 2;
			}
		}
		const c = new C();
		api.autorun(() => log(c.twice));
		c.twice = 10;
		log(c.n);
	});

	parity("may not change state", (api, log) => {
		api.configure({ enforceActions: "observed" });
		const o = api.observable.box(1);
		api.autorun(() => o.get());
		const c = api.computed(() => {
			o.set(2);
			return 1;
		});
		log(c.get());
		api.runInAction(() => log(c.get()));
	});

	parity("requiresReaction and computedRequiresReaction", (api, log) => {
		const c = api.computed(() => 1, { requiresReaction: true });
		c.get();
		log("-");
		api.configure({ computedRequiresReaction: true });
		const d = api.computed(() => 1);
		d.get();
		api.computed(() => 1, { requiresReaction: false }).get();
		api.runInAction(() => d.get());
		api.configure({ computedRequiresReaction: false });
		log("end");
	});
});

describe("autorun and reaction", () => {
	parity("start at the end of the action they're created in", (api, log) => {
		api.runInAction(() => {
			api.autorun(() => log("autorun"));
			api.reaction(
				() => log("data"),
				() => log("effect"),
				{ fireImmediately: true },
			);
			log("in action");
		});
	});

	parity("delay and scheduler", async (api, log) => {
		vi.useFakeTimers();
		try {
			const o = api.observable.box(1);
			api.autorun(() => log("autorun", o.get()), { delay: 50 });
			api.reaction(
				() => o.get(),
				(v: number) => log("reaction", v),
				{ delay: 20 },
			);
			const queue: Array<() => void> = [];
			api.autorun(() => log("scheduled", o.get()), {
				scheduler: (run: () => void) => queue.push(run),
			});
			api.reaction(
				() => o.get(),
				(v: number) => log("scheduled reaction", v),
				{ scheduler: (run: () => void) => queue.push(run) },
			);
			log("queue", queue.length);
			o.set(2);
			o.set(3);
			vi.advanceTimersByTime(30);
			log("30");
			vi.advanceTimersByTime(30);
			log("60");
			o.set(4);
			log("queue", queue.length);
			for (const run of queue.splice(0)) run();
			vi.advanceTimersByTime(100);
		} finally {
			vi.useRealTimers();
		}
	});

	parity("onError and onReactionError", (api, log) => {
		const o = api.observable.box(1);
		const fail = (v: number) => {
			if (v > 1) throw new Error(`v${v}`);
		};
		api.autorun(() => fail(o.get()), {
			onError: (e: Error) => log("autorun", e),
		});
		api.reaction(
			() => o.get(),
			(v: number) => fail(v),
			{ onError: (e: Error) => log("effect", e) },
		);
		api.reaction(
			() => fail(o.get()),
			() => log("never"),
			{ onError: (e: Error) => log("data", e) },
		);
		o.set(2);
		const stop = api.onReactionError((e: Error) => log("global", e));
		api.autorun(() => fail(o.get()));
		stop();
		api.autorun(() => fail(o.get()));
	});

	parity("signal", (api, log) => {
		const o = api.observable.box(1);
		const controller = new AbortController();
		api.autorun(() => log("autorun", o.get()), { signal: controller.signal });
		api.reaction(
			() => o.get(),
			(v: number) => log("reaction", v),
			{ signal: controller.signal },
		);
		o.set(2);
		controller.abort();
		o.set(3);
		api.autorun(() => log("never"), { signal: controller.signal });
		log("end");
	});

	parity("requiresObservable and reactionRequiresObservable", (api, log) => {
		api.autorun(() => {}, { requiresObservable: true });
		log("-");
		api.configure({ reactionRequiresObservable: true });
		api.autorun(() => {});
		api.autorun(() => {}, { requiresObservable: false });
		api.autorun(() => api.observable.box(1).get());
		api.configure({ reactionRequiresObservable: false });
		log("end");
	});

	parity("observableRequiresReaction", (api, log) => {
		const o = api.observable({ a: 1, list: [1], m: new Map([["x", 1]]) });
		const box = api.observable.box(1);
		api.configure({ observableRequiresReaction: true });
		void o.a;
		log("a");
		box.get();
		log("box");
		o.list.slice();
		log("list");
		api.autorun(() => o.a);
		api.runInAction(() => o.a);
		log("allowed");
		api.configure({ observableRequiresReaction: false });
		void o.a;
		log("off");
	});

	parity("disableErrorBoundaries", (api, log) => {
		api.configure({ disableErrorBoundaries: true });
		log(
			throws(() =>
				api.autorun(() => {
					throw new Error("x");
				}),
			),
		);
		api._resetGlobalState();
		const c = api.computed(() => {
			throw new Error("y");
		});
		log(throws(() => c.get()));
		api.configure({ disableErrorBoundaries: false });
	});

	parity("that never converge", (api, log) => {
		const o = api.observable.box(1);
		api.autorun(() => {
			o.get();
			api.untracked(() => o.set(o.get() + 1));
		});
		log(o.get() > 10);
	});

	parity("the disposer and the reaction", (api, log) => {
		const o = api.observable.box(1);
		const stop = api.autorun((r: Any) => {
			log(o.get());
			if (o.get() === 2) r.dispose();
		});
		log(stop[api.$mobx] !== undefined, typeof stop[api.$mobx].dispose);
		o.set(2);
		o.set(3);
		const r = new api.Reaction("name", () => log("invalidated"));
		r.track(() => o.get());
		o.set(4);
		o.set(5);
		r.track(() => o.get());
		o.set(6);
		r.dispose();
		o.set(7);
		log(`${r}`, r.isDisposed);
	});

	parity("errors in actions don't log errors in reactions", (api, log) => {
		const o = api.observable.box(1);
		api.autorun(() => {
			if (o.get() === 2) throw new Error("reaction");
		});
		log(
			throws(() =>
				api.runInAction(() => {
					o.set(2);
					throw new Error("action");
				}),
			),
		);
	});
});

describe("when and flow", () => {
	parity("timeout, onError, signal, cancel", async (api, log) => {
		vi.useFakeTimers();
		try {
			const o = api.observable.box(1);
			api.when(
				() => o.get() > 5,
				() => log("never"),
				{ timeout: 10, onError: (e: Error) => log("effect", e) },
			);
			const p = api.when(() => o.get() > 5, { timeout: 10 });
			p.catch((e: Error) => log("promise", e));
			const cancelled = api.when(() => o.get() > 5);
			cancelled.catch((e: Error) => log("cancelled", e));
			cancelled.cancel();
			const controller = new AbortController();
			const aborted = api.when(() => o.get() > 5, {
				signal: controller.signal,
			});
			aborted.catch((e: Error) => log("aborted", e));
			controller.abort();
			const already = api.when(() => true, { signal: controller.signal });
			already.catch((e: Error) => log("already", e));
			log(typeof already.cancel);
			await vi.advanceTimersByTimeAsync(20);
			log(throws(() => api.when(() => true, { onError: () => {} })));
			api.when(
				() => o.get() === 3,
				() => log("three"),
			);
			o.set(3);
		} finally {
			vi.useRealTimers();
		}
	});

	parity("flows: names, cancel, nested cancel, finally", async (api, log) => {
		log(
			api.isFlow(api.flow(function* () {})),
			api.isFlow(() => {}),
		);
		log(api.flowResult(5));
		const inner = api.flow(function* inner() {
			try {
				yield new Promise(() => {});
			} finally {
				log("inner finally");
			}
		});
		const outer = api.flow(function* outer(): Any {
			try {
				yield inner();
			} finally {
				log("outer finally");
			}
		});
		const p = outer();
		p.cancel();
		await p.catch((e: Error) => log(api.isFlowCancellationError(e), `${e}`));
		const ok = await api.flow(function* (a: number): Any {
			const b = yield Promise.resolve(a + 1);
			return b * 2;
		})(1);
		log(ok);
		await api
			.flow(function* (): Any {
				try {
					yield Promise.reject(new Error("x"));
				} catch (e) {
					log("caught", e as Error);
				}
				throw new Error("out");
			})()
			.catch((e: Error) => log(e));
		const events: unknown[] = [];
		const stop = api.spy((e: Any) => {
			if (e.type === "action") events.push(e.name.replace(/\d+/g, "N"));
		});
		await api.flow(function* named(): Any {
			yield 1;
		})();
		stop();
		log(events);
	});

	parity("async generator flows", async (api, log) => {
		const f = api.flow(async function* (): Any {
			const a = await Promise.resolve(1);
			const b: number = yield Promise.resolve(2);
			return a + b;
		});
		log(await f());
	});
});

describe("observe", () => {
	parity("objects", (api, log) => {
		const o = api.observable(
			{
				a: 1,
				nested: { x: 1 },
				get c() {
					return this.a * 2;
				},
				m() {},
			} as Any,
			{},
			{ name: "o" },
		);
		const stop = api.observe(o, (change: Any) => {
			log(change, change.object === o);
		});
		o.a = 2;
		o.a = 2;
		api.set(o, "b", { y: 1 });
		api.set(o, "b", 3);
		api.remove(o, "b");
		o.nested = { x: 2 };
		o.nested.x = 3;
		api.runInAction(() => {
			o.a = 5;
			o.a = 6;
		});
		stop();
		stop();
		o.a = 7;
		log(throws(() => api.observe(o, () => {}, true)));
	});

	parity("properties and computeds", (api, log) => {
		const o = api.observable(
			{
				a: 1,
				get c() {
					return this.a * 2;
				},
			},
			{},
			{ name: "o" },
		);
		const pick = ({ type, newValue, oldValue, observableKind }: Any) => ({
			type,
			newValue,
			oldValue,
			observableKind,
		});
		api.observe(o, "a", (c: Any) => log("a", pick(c)));
		api.observe(o, "a", (c: Any) => log("a now", pick(c)), true);
		const stop = api.observe(o, "c", (c: Any) => log("c", pick(c)));
		api.observe(o, "c", (c: Any) => log("c now", pick(c)), true);
		o.a = 2;
		stop();
		o.a = 3;
		const c = api.computed(() => o.a + 1, { name: "plus" });
		api.observe(c, (change: Any) => log(change.debugObjectName, pick(change)));
		o.a = 10;
	});

	parity("arrays", (api, log) => {
		const a = api.observable([1, 2, 3], { name: "a" });
		api.observe(a, (c: Any) => log(c, c.object === a));
		api.observe(a, (c: Any) => log("now", c.type, c.added), true);
		a.push(4, 5);
		a.pop();
		a.shift();
		a.unshift(0);
		a.splice(1, 2, 9, 8, 7);
		a.splice(1);
		a.push();
		api.set(a, 0, 100);
		api.set(a, 0, 100);
		api.set(a, 3, "far");
		a.sort();
		a.reverse();
		a.clear();
		a.replace([1, 2]);
		a.remove(2);
		a.remove(42);
		a.spliceWithArray(0, 1, [5, 6]);
		log(a.toJSON());
	});

	proxyParity("arrays changed with plain JavaScript", (api, log) => {
		const a = api.observable([1, 2, 3], { name: "a" });
		api.observe(a, (c: Any) => log(c));
		a[0] = 10;
		a[5] = 50;
		a.length = 2;
		a.length = 4;
		a.fill(0);
		[a[0], a[1]] = [7, 8];
		log(a);
	});

	parity("maps", (api, log) => {
		const m = api.observable.map({ a: 1 }, { name: "m" });
		api.observe(m, (c: Any) => log(c, c.object === m));
		m.set("b", { x: 1 });
		m.set("a", 2);
		m.set("a", 2);
		m.delete("a");
		m.delete("nope");
		m.merge({ c: 3, d: 4 });
		m.merge(new Map([["e", 5]]));
		m.merge([["f", 6]]);
		m.replace({ d: 4, z: 26, c: 33 });
		log([...m.keys()]);
		m.replace(new Map([["c", 33]]));
		m.clear();
		log(m.getOrInsert("k", 1), m.getOrInsert("k", 2));
		log(m.getOrInsertComputed("l", (k: string) => `${k}!`));
		log(`${m}`, m.toJSON(), Object.prototype.toString.call(m));
		log(throws(() => api.observe(m, () => {}, true)));
		api.observe(m, "k", (c: Any) => log("entry", c.newValue, c.oldValue));
		m.set("k", 9);
	});

	parity("sets", (api, log) => {
		const s = api.observable.set([1], { name: "s" });
		api.observe(s, (c: Any) => log(c, c.object === s));
		s.add(2);
		s.add(2);
		s.delete(1);
		s.delete(42);
		s.replace([7, 8]);
		s.replace(new Set([9]));
		s.clear();
		log(`${s}`, s.toJSON(), Object.prototype.toString.call(s));
	});

	parity("boxes", (api, log) => {
		const b = api.observable.box({ x: 1 }, { name: "b" });
		api.observe(b, (c: Any) => log(c.type, c.newValue, c.oldValue));
		api.observe(b, (c: Any) => log("now", c.newValue, c.debugObjectName), true);
		b.set({ x: 2 });
		b.set(5);
		b.set(5);
		log(b + 1, `${b}`, `${api.observable.box(1, { name: "n" })}`);
		log(api.observable.box(null) == null, JSON.stringify(b));
	});

	parity("listeners aren't tracked, and may unsubscribe", (api, log) => {
		const o = api.observable({ a: 1, b: 1 });
		let runs = 0;
		api.autorun(() => {
			runs++;
			if (runs === 1) {
				const stop = api.observe(o, "a", () => {
					void o.b;
					stop();
				});
			}
			void o.a;
		});
		o.a = 2;
		o.b = 2;
		log(runs);
	});
});

describe("intercept", () => {
	parity("objects", (api, log) => {
		const o = api.observable({ a: 1 } as Any, {}, { name: "o" });
		const stop = api.intercept(o, (change: Any) => {
			log(change);
			if (change.newValue === "no") return null;
			if (change.type === "remove" && change.name === "keep") return null;
			if (change.newValue === "change") change.newValue = "changed";
			return change;
		});
		o.a = 2;
		o.a = "no";
		o.a = "change";
		api.set(o, "b", "change");
		api.set(o, "c", "no");
		api.set(o, "keep", 1);
		api.remove(o, "keep");
		api.remove(o, "b");
		log(api.keys(o), o.a);
		stop();
		o.a = "no";
		log(o.a);
	});

	proxyParity("objects changed with plain JavaScript", (api, log) => {
		const o = api.observable({ a: 1 } as Any);
		api.intercept(o, (c: Any) => (c.name === "no" ? null : c));
		o.no = 1;
		o.yes = 1;
		delete o.yes;
		Object.defineProperty(o, "no", { value: 1, configurable: true });
		log(Object.keys(o));
	});

	parity("properties, boxes and computeds", (api, log) => {
		const o = api.observable({ a: 1 });
		api.intercept(o, "a", (c: Any) => {
			c.newValue *= 2;
			return c;
		});
		o.a = 5;
		log(o.a);
		const b = api.observable.box(1);
		const stop = api.intercept(b, (c: Any) => (c.newValue > 10 ? null : c));
		b.set(5);
		b.set(50);
		log(b.get());
		stop();
		b.set(50);
		log(b.get());
		log(
			throws(() => {
				api.intercept(b, () => ({}));
				b.set(1);
			}),
		);
	});

	parity("arrays", (api, log) => {
		const a = api.observable([1], { name: "a" });
		api.intercept(a, (c: Any) => {
			log(c);
			if (c.type === "splice") {
				if (c.added.includes("no")) return null;
				c.added = c.added.map((x: Any) => (x === 5 ? 50 : x));
			} else if (c.newValue === "no") return null;
			return c;
		});
		a.push(5, 6);
		a.push("no");
		api.set(a, 0, "no");
		api.set(a, 0, 7);
		a.pop();
		log(a);
	});

	parity("maps and sets", (api, log) => {
		const m = api.observable.map({ a: 1 }, { name: "m" });
		api.intercept(m, (c: Any) => {
			log(c);
			if (c.newValue === "no" || (c.type === "delete" && c.name === "a")) {
				return null;
			}
			if (c.newValue === 5) c.newValue = 50;
			return c;
		});
		m.set("a", 5);
		m.set("b", "no");
		m.set("c", 3);
		m.delete("a");
		m.delete("c");
		m.replace({ z: 1 });
		log([...m]);
		const entry = api.observable.map({ a: 1 });
		api.intercept(entry, "a", (c: Any) => {
			c.newValue = -c.newValue;
			return c;
		});
		entry.set("a", 9);
		log(entry.get("a"));
		const s = api.observable.set([1], { name: "s" });
		api.intercept(s, (c: Any) => {
			log(c);
			if (c.newValue === 5) c.newValue = 50;
			return c.newValue === "no" || c.oldValue === 1 ? null : c;
		});
		s.add(5);
		s.add("no");
		s.delete(1);
		s.delete(50);
		log([...s]);
	});
});

describe("onBecomeObserved / onBecomeUnobserved", () => {
	parity("boxes, properties, computeds, collections", (api, log) => {
		const things: Record<string, [Any, Any?]> = {
			box: [api.observable.box(1)],
			property: [api.observable({ a: 1 }), "a"],
			array: [api.observable([1])],
			map: [api.observable.map({ a: 1 })],
			entry: [api.observable.map({ a: 1 }), "a"],
			set: [api.observable.set([1])],
		};
		const read: Record<string, () => unknown> = {
			box: () => things.box?.[0].get(),
			property: () => things.property?.[0].a,
			array: () => things.array?.[0].slice(),
			map: () => things.map?.[0].size,
			entry: () => things.entry?.[0].get("a"),
			set: () => things.set?.[0].size,
		};
		for (const [name, [thing, property]] of Object.entries(things)) {
			const args = property === undefined ? [thing] : [thing, property];
			const off = api.onBecomeObserved(...args, () => log(`${name} observed`));
			api.onBecomeUnobserved(...args, () => log(`${name} unobserved`));
			read[name]?.();
			log("read");
			const a = api.autorun(() => read[name]?.());
			const b = api.autorun(() => read[name]?.());
			a();
			log("one left");
			b();
			off();
			api.autorun(() => read[name]?.())();
		}
	});

	parity("computeds and their dependencies", (api, log) => {
		const o = api.observable.box(1);
		const c = api.computed(() => o.get());
		for (const [name, thing] of [
			["o", o],
			["c", c],
		] as const) {
			api.onBecomeObserved(thing, () => log(`${name} observed`));
			api.onBecomeUnobserved(thing, () => log(`${name} unobserved`));
		}
		c.get();
		api.runInAction(() => c.get());
		log("read");
		const stop = api.autorun(() => c.get());
		stop();
		log("end");
	});

	parity("at the end of the batch", (api, log) => {
		const o = api.observable.box(1);
		api.onBecomeObserved(o, () => log("observed"));
		api.onBecomeUnobserved(o, () => log("unobserved"));
		let stop = api.autorun(() => o.get());
		api.runInAction(() => {
			stop();
			log("stopped");
			stop = api.autorun(() => o.get());
			log("started");
		});
		log("after");
		api.runInAction(() => {
			stop();
			log("stopped");
		});
	});

	parity("conditional dependencies", (api, log) => {
		const flag = api.observable.box(true);
		const a = api.observable.box(1);
		api.onBecomeObserved(a, () => log("observed"));
		api.onBecomeUnobserved(a, () => log("unobserved"));
		api.autorun(() => (flag.get() ? a.get() : 0));
		flag.set(false);
		flag.set(true);
	});

	parity("createAtom", (api, log) => {
		const atom = api.createAtom(
			"clock",
			() => log("observed"),
			() => log("unobserved"),
		);
		log(atom.reportObserved());
		let runs = 0;
		const stop = api.autorun(() => {
			runs++;
			log(atom.reportObserved());
		});
		atom.reportChanged();
		api.runInAction(() => {
			atom.reportChanged();
			atom.reportChanged();
		});
		log(runs);
		stop();
		log(`${atom}`, api.getDebugName(atom));
	});
});

describe("spy", () => {
	const spying = (api: Any, log: Log, fn: () => void) => {
		const stop = api.spy((event: Any) => {
			const { time: _, ...rest } = event;
			// MobX's internal "no value yet".
			if (rest.oldValue?.constructor?.name === "CaughtException") {
				rest.oldValue = undefined;
			}
			if (rest.type === "error") rest.message = "worded differently";
			// `this` of the function (the module namespace for `api.runInAction`).
			if (rest.type === "action") rest.object = rest.object !== undefined;
			log(rest);
		});
		fn();
		stop();
	};

	parity("objects", (api, log) => {
		spying(api, log, () => {
			const o = api.observable({ a: 1 } as Any, {}, { name: "o" });
			o.a = 2;
			api.set(o, "b", 1);
			api.remove(o, "b");
		});
	});

	parity("collections and boxes", (api, log) => {
		spying(api, log, () => {
			const a = api.observable([1], { name: "a" });
			a.push(2);
			api.set(a, 0, 5);
			const m = api.observable.map({ i: 1 }, { name: "m" });
			m.set("x", 1);
			m.set("x", 2);
			m.delete("x");
			const s = api.observable.set([7], { name: "s" });
			s.add(1);
			s.delete(1);
			const b = api.observable.box(1, { name: "b" });
			b.set(2);
		});
	});

	parity("actions, reactions, computeds, errors", (api, log) => {
		const b = api.observable.box(1, { name: "b" });
		const c = api.computed(() => b.get() * 2, { name: "c" });
		spying(api, log, () => {
			const stop = api.autorun(() => c.get(), { name: "run" });
			api.action("named", (x: number) => b.set(x))(5);
			api.action(function fn() {
				b.set(6);
			})();
			const { runInAction } = api;
			runInAction(() => b.set(7));
			stop();
			api.autorun(
				() => {
					throw new Error("x");
				},
				{ name: "fails" },
			);
		});
		b.set(100);
		log("end");
	});

	parity("class actions", (api, log) => {
		class C {
			n = 1;
			constructor() {
				api.makeAutoObservable(this, {}, { name: "C" });
			}
			inc() {
				this.n++;
			}
			get d() {
				return this.n * 2;
			}
		}
		const c = new C();
		const types: unknown[] = [];
		const stop = api.spy((e: Any) => types.push([e.type, e.name]));
		c.inc();
		stop();
		log(types);
	});
});

describe("names and trees", () => {
	parity("getDebugName", (api, log) => {
		const o = api.observable(
			{ a: { b: [{ c: 1 }] }, m: new Map() } as Any,
			{},
			{
				name: "root",
			},
		);
		log(api.getDebugName(o), api.getDebugName(o, "a"), api.getDebugName(o.a));
		log(api.getDebugName(o.a.b), api.getDebugName(o.a.b[0]));
		log(api.getDebugName(o.m));
		o.m.set("k", {});
		log(api.getDebugName(o.m, "k"), api.getDebugName(o.m.get("k")));
		for (const make of [
			() => api.observable({}),
			() => api.observable([]),
			() => api.observable.map(),
			() => api.observable.set(),
			() => api.observable.box(1),
			() => api.computed(() => 1),
			() => api.createAtom(),
			() => api.autorun(() => {}),
			() =>
				api.reaction(
					() => 1,
					() => {},
				),
			() => api.action("act", () => {}),
		]) {
			log(api.getDebugName(make()).replace(/@\d+/, "@N"));
		}
		class Store {
			x = 1;
			constructor() {
				api.makeAutoObservable(this);
			}
		}
		log(api.getDebugName(new Store(), "x").replace(/@\d+/, "@N"));
		log(throws(() => api.getDebugName({})));
	});

	parity("getDependencyTree and getObserverTree", (api, log) => {
		const o = api.observable({ a: 1, b: 2 }, {}, { name: "o" });
		const c = api.computed(() => o.a + o.b + o.a, { name: "c" });
		const stop = api.autorun(() => c.get() + o.b, { name: "run" });
		log(api.getDependencyTree(stop), api.getDependencyTree(c));
		log(api.getObserverTree(o, "a"), api.getObserverTree(o, "b"));
		log(api.getObserverTree(c));
		stop();
		log(api.getDependencyTree(stop), api.getObserverTree(o, "a"));
	});

	parity("trace", (api, log) => {
		const o = api.observable.box(1, { name: "o" });
		const c = api.computed(() => o.get(), { name: "c" });
		api.trace(c);
		const stop = api.autorun(() => {
			api.trace();
			c.get();
		});
		o.set(2);
		log("changed");
		stop();
		c.get();
		log(throws(() => api.trace()));
	});

	parity("getAtom, isObservableProp, isComputedProp", (api, log) => {
		const o = api.observable({
			a: 1,
			get c() {
				return 1;
			},
			m() {},
		} as Any);
		class C {
			x = 1;
			plain = 1;
			constructor() {
				api.makeObservable(this, { x: api.observable, y: api.computed });
			}
			get y() {
				return 1;
			}
		}
		const c = new C();
		log(["a", "c", "m", "nope"].map((k) => api.isObservableProp(o, k)));
		log(["a", "c", "m", "nope"].map((k) => api.isComputedProp(o, k)));
		log(["x", "y", "plain"].map((k) => api.isObservableProp(c, k)));
		log(["x", "y", "plain"].map((k) => api.isComputedProp(c, k)));
		log(api.isObservableProp({}, "x"), api.isObservableProp(null, "x"));
		log(
			[o, c, api.observable.box(1), api.computed(() => 1), {}, null].map((x) =>
				api.isObservable(x),
			),
		);
		log(
			throws(() => api.getAtom(o)),
			throws(() => api.getAtom(o, "nope")),
		);
		log(api.isObservable(api.getAtom(o, "a")));
		log(o[api.$mobx] !== undefined, Object.keys(o).length);
		log(api.ownKeys(o).filter((k: Any) => typeof k === "string"));
		api.defineProperty(o, "d", { value: 1, enumerable: true });
		log(api.keys(o).includes("d"));
	});
});

describe("extendObservable and classes", () => {
	parity("extendObservable", (api, log) => {
		const target: Any = { plain: 1 };
		const result = api.extendObservable(
			target,
			{
				a: 1,
				ref: { x: 1 },
				get c() {
					return this.a * 2;
				},
				inc() {
					this.a++;
				},
			},
			{ ref: api.observable.ref },
		);
		log(result === target, api.isObservable(target));
		log(api.isObservable(target.ref), api.isObservableProp(target, "plain"));
		api.autorun(() => log(target.a, target.c));
		target.inc();
		api.extendObservable(target, { z: 1 });
		log(Object.keys(target), api.isObservableProp(target, "z"));
		log(throws(() => api.extendObservable(target, 1)));
		log(throws(() => api.extendObservable(target, api.observable({}))));
		log(throws(() => api.extendObservable(api.observable.map(), {})));
		log(throws(() => api.extendObservable(Object.freeze({}), { a: 1 })));
		class C {
			constructor() {
				api.extendObservable(this, { x: 1 });
			}
		}
		log(api.isObservableProp(new C(), "x"));
	});

	parity("inheritance and override", (api, log) => {
		class Base {
			x = 1;
			calls: string[] = [];
			constructor() {
				api.makeObservable(this, {
					x: api.observable,
					double: api.computed,
					act: api.action,
					bound: api.action.bound,
				});
			}
			get double() {
				return this.x * 2;
			}
			act() {
				this.x++;
				this.calls.push("base act");
			}
			bound() {
				this.x += 10;
			}
		}
		class Sub extends Base {
			y = 5;
			constructor() {
				super();
				api.makeObservable(this, {
					y: api.observable,
					double: api.override,
					act: api.override,
					sum: api.computed,
				});
			}
			override get double() {
				return super.double + 100;
			}
			override act() {
				super.act();
				this.calls.push("sub act");
			}
			get sum() {
				return this.x + this.y;
			}
		}
		const s = new Sub();
		api.autorun(() => log(s.double, s.sum));
		s.act();
		const { bound } = s;
		bound();
		log(s.calls, api.isAction(s.act), api.isAction(Base.prototype.act));
		const b = new Base();
		b.act();
		log(b.x, b.calls);
		class Bad extends Base {
			constructor() {
				super();
				api.makeObservable(this, { x: api.observable });
			}
		}
		log(throws(() => new Bad()));
		class BadOverride extends Base {
			constructor() {
				super();
				api.makeObservable(this, { nope: api.override });
			}
		}
		log(throws(() => new BadOverride()));
		class SubAuto extends Base {
			constructor() {
				super();
				api.makeAutoObservable(this);
			}
		}
		log(throws(() => new SubAuto()));
		log(
			throws(() =>
				api.makeObservable({ a: 1 }, { nope: api.observable } as Any),
			),
		);
	});

	parity("safeDescriptors", (api, log) => {
		const make = () => {
			class C {
				x = 1;
				constructor() {
					api.makeObservable(this, { x: api.observable, act: api.action });
				}
				act() {}
			}
			return new C() as Any;
		};
		const c = make();
		log(
			throws(() => Object.defineProperty(c, "x", { value: 1 })),
			Object.getOwnPropertyDescriptor(c, "x")?.configurable,
		);
		const o = api.observable({ act() {} }, { act: api.action }) as Any;
		log(
			throws(() => {
				o.act = () => {};
			}),
		);
		api.configure({ safeDescriptors: false });
		const d = make();
		log(throws(() => Object.defineProperty(d, "x", { value: 1 })));
		const p = api.observable({ act() {} }, { act: api.action }) as Any;
		log(
			throws(() => {
				p.act = () => {};
			}),
		);
		api.configure({ safeDescriptors: true });
	});

	parity("functions in deep observables are auto-actions", (api, log) => {
		const o = api.observable(
			{
				n: 1,
				f: null as Any,
				list: [] as Any[],
				ref: null as Any,
			},
			{ ref: api.observable.ref },
		);
		const fn = function (this: Any) {
			o.n++;
			o.n++;
		};
		o.f = fn;
		o.ref = fn;
		o.list.push(fn);
		log(api.isAction(o.f), api.isAction(o.ref), api.isAction(o.list[0]));
		let runs = 0;
		api.autorun(() => {
			runs++;
			void o.n;
		});
		o.f();
		log(runs, o.f === fn);
		class K {}
		const k = api.observable.box(K, { deep: false });
		log(k.get() === K);
	});

	parity("auto-actions in derivations", (api, log) => {
		api.configure({ enforceActions: "observed" });
		const o = api.observable({
			n: 1,
			read() {
				return this.n;
			},
			write() {
				this.n = 100;
			},
		});
		api.autorun(() => log("run", o.read()));
		api.runInAction(() => {
			o.n = 2;
		});
		const c = api.computed(() => {
			o.write();
			return 1;
		});
		c.get();
		log(o.n);
	});

	parity(
		"observable.object, defaultDecorator, makeObservable on plain objects",
		(api, log) => {
			const o = api.observable.object({ a: { x: 1 }, b: 1 }, { b: false });
			log(api.isObservable(o.a), api.isObservableProp(o, "b"));
			const r = api.observable(
				{ a: { x: 1 } },
				{},
				{
					defaultDecorator: api.observable.ref,
				},
			);
			log(api.isObservable(r.a));
			const m = api.makeObservable(
				{
					a: 1,
					inc() {
						this.a++;
					},
				} as Any,
				{ a: api.observable, inc: api.action },
			);
			api.autorun(() => log(m.a));
			m.inc();
			const auto = api.makeAutoObservable({
				a: 1,
				get d() {
					return this.a * 2;
				},
			});
			api.autorun(() => log(auto.d));
			auto.a = 5;
			log(throws(() => api.makeAutoObservable(auto)));
		},
	);

	parity("action names and factories", (api, log) => {
		log(api.action("n", () => {}).name, api.action(function f() {}).name);
		log(api.runInAction(() => 5));
		const o = api.makeObservable(
			{ a: 1, act() {} },
			{ a: api.observable, act: api.action("custom") },
		) as Any;
		log(o.act.name);
		const k = api.makeObservable(
			{
				get c() {
					return {};
				},
			} as Any,
			{ c: api.computed({ keepAlive: true }) },
		);
		const first = k.c;
		log(k.c === first);
		log(api.isAction(api._autoAction(() => {})));
		log(throws(() => api.action()));
	});
});

describe("legacy decorators", () => {
	/** Apply decorators the way TypeScript's `experimentalDecorators` does. */
	const decorate = (
		proto: Any,
		members: Record<string, (target: object, key: string, d?: Any) => Any>,
	) => {
		for (const [key, decorator] of Object.entries(members)) {
			const descriptor = Object.getOwnPropertyDescriptor(proto, key);
			const result = decorator(proto, key, descriptor);
			if (result && descriptor) Object.defineProperty(proto, key, result);
		}
	};

	parity("fields, getters, methods and flows", async (api, log) => {
		class C {
			x = 1;
			ref = { a: 1 };
			deep = { a: 1 };
			constructor() {
				api.makeObservable(this);
			}
			get double() {
				return this.x * 2;
			}
			inc() {
				this.x++;
			}
			bound() {
				this.x += 10;
			}
			named() {}
			*flow(): Any {
				this.x = yield Promise.resolve(100);
			}
		}
		decorate(C.prototype, {
			x: api.observable,
			ref: api.observable.ref,
			deep: api.observable,
			double: api.computed,
			inc: api.action,
			bound: api.action.bound,
			named: api.action("custom"),
			flow: api.flow,
		});
		const c = new C() as Any;
		api.autorun(() => log(c.x, c.double));
		c.inc();
		const { bound } = c;
		bound();
		await c.flow();
		log(api.isObservable(c.deep), api.isObservable(c.ref), c.named.name);
		log(
			api.isComputedProp(c, "double"),
			api.isAction(c.inc),
			api.isFlow(c.flow),
		);
		const d = new C() as Any;
		d.inc();
		log(d.x, c.x);
	});

	parity("inheritance", (api, log) => {
		class Base {
			x = 1;
			constructor() {
				api.makeObservable(this);
			}
			get v() {
				return this.x;
			}
			act() {
				this.x++;
			}
		}
		decorate(Base.prototype, {
			x: api.observable,
			v: api.computed,
			act: api.action,
		});
		class Sub extends Base {
			y = 10;
			constructor() {
				super();
				api.makeObservable(this);
			}
			override get v() {
				return super.v + this.y;
			}
			get sum() {
				return this.x + this.y;
			}
		}
		decorate(Sub.prototype, {
			y: api.observable,
			v: api.override,
			sum: api.computed,
		});
		const s = new Sub();
		api.autorun(() => log(s.v, s.sum));
		s.act();
		s.y = 20;
		log(throws(() => decorate(Sub.prototype, { x: api.observable })));
		log(throws(() => decorate(Sub.prototype, { nope: api.override })));
		log(throws(() => api.makeObservable(new Base(), { x: api.observable })));
	});
});

describe("collections", () => {
	parity("array methods", (api, log) => {
		const a = api.observable([3, 1, 2]);
		log(a.clear(), a.length);
		a.replace([1, 2, 3]);
		log(a.spliceWithArray(1), a.spliceWithArray(0, 0, [7, 8]), a.toJSON());
		log(a.remove(7), a.remove(99), a.slice());
		api.autorun(() => {
			try {
				a.sort();
			} catch {
				log("sort throws in derivations");
			}
		});
		log(a.sort() === a, a.reverse() === a, a.slice());
		log(throws(() => api.set(a, -1, 1)));
		const big = api.observable([]);
		big.push(...new Array(5));
		big.spliceWithArray(
			0,
			1,
			Array.from({ length: 20000 }, (_, i) => i),
		);
		log(big.length, big[0], big[19999], big[20003]);
	});

	parity("defaultDecorator", (api, log) => {
		for (const kind of ["ref", "shallow", "struct", "deep"]) {
			const options = { defaultDecorator: api.observable[kind] };
			const a = api.observable.array([{ x: 1 }], options);
			const m = api.observable.map({ k: [{ x: 1 }] }, options);
			const s = api.observable.set([{ x: 1 }], options);
			const b = api.observable.box([{ x: 1 }], options);
			log(kind, api.isObservable(a.slice()[0]), api.isObservable(m.get("k")));
			log(api.isObservable(m.get("k")[0]), api.isObservable([...s][0]));
			log(api.isObservable(b.get()), api.isObservable(b.get()[0]));
			let runs = 0;
			api.autorun(() => {
				runs++;
				log(a.slice(), m.get("k"), b.get());
			});
			api.set(a, 0, { x: 1 });
			m.set("k", [{ x: 1 }]);
			b.set([{ x: 1 }]);
			log(runs);
		}
	});

	parity("set operations", (api, log) => {
		const a = api.observable.set([1, 2, 3]);
		const b: Any = new Set([2, 3, 4]);
		let runs = 0;
		// The order is JavaScript's own (MobX's differs: it runs them on the other set).
		const sorted = (set: Set<number>) => [...set].sort();
		api.autorun(() => {
			runs++;
			log(sorted(a.union(b)), sorted(a.intersection(b)));
			log(sorted(a.difference(b)));
			log(sorted(a.symmetricDifference(b)), a.isSubsetOf(b), a.isSupersetOf(b));
			log(a.isDisjointFrom(b), sorted(b.union(a)));
		});
		a.add(4);
		log(runs);
	});

	parity("map reactions per key, keys and values", (api, log) => {
		const m = api.observable.map({ a: 1, b: 2 });
		const counts: Record<string, number> = {};
		const count = (name: string, fn: () => unknown) =>
			api.autorun(() => {
				counts[name] = (counts[name] ?? 0) + 1;
				fn();
			});
		count("get a", () => m.get("a"));
		count("has c", () => m.has("c"));
		count("keys", () => [...m.keys()]);
		count("size", () => m.size);
		count("values", () => [...m.values()]);
		m.set("a", 2);
		m.set("c", 3);
		m.delete("b");
		m.replace({ c: 3, a: 2 });
		m.merge({ a: 2 });
		log(counts);
	});
});
