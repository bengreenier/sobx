import {
	autorun,
	comparer,
	flow,
	isFlowCancellationError,
	makeAutoObservable,
	makeObservable,
	ObservableMap,
	ObservableSet,
	observable,
	ProxyLike,
	reaction,
	when,
} from "./index.js";

describe("comparer", () => {
	it("default, identity, structural, shallow", () => {
		expect(comparer.default(Number.NaN, Number.NaN)).toBe(true);
		expect(comparer.identity(Number.NaN, Number.NaN)).toBe(false);
		expect(
			comparer.structural({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }),
		).toBe(true);
		expect(comparer.shallow({ a: 1 }, { a: 1 })).toBe(true);
		expect(comparer.shallow({ a: {} }, { a: {} })).toBe(false);
	});

	it("works as a reaction's equals", () => {
		const s = new ProxyLike({ point: { x: 1 } });
		const effect = vi.fn();
		reaction(() => s.get("point"), effect, { equals: comparer.structural });
		s.set("point", { x: 1 });
		expect(effect).not.toHaveBeenCalled();
		s.set("point", { x: 2 });
		expect(effect).toHaveBeenCalledTimes(1);
	});
});

describe("observable.box", () => {
	it("tracks get and notifies on set, with equals", () => {
		const b = observable.box(1, { equals: (a, c) => Math.abs(a - c) < 1 });
		const seen: number[] = [];
		autorun(() => {
			seen.push(b.get());
		});
		b.set(1.5);
		b.set(3);
		expect(seen).toEqual([1, 3]);
	});
});

describe("observable maps", () => {
	it("tracks keys (including missing ones) and the whole map", () => {
		const m = observable.map<string, number>({ a: 1 });
		expect(m).toBeInstanceOf(ObservableMap);
		const a = vi.fn(() => m.get("a"));
		const hasB = vi.fn(() => m.has("b"));
		const size = vi.fn(() => m.size);
		autorun(a);
		autorun(hasB);
		autorun(size);
		m.set("c", 3); // neither a nor b
		expect([a, hasB, size].map((f) => f.mock.calls.length)).toEqual([1, 1, 2]);
		m.set("b", 2);
		expect([a, hasB, size].map((f) => f.mock.calls.length)).toEqual([1, 2, 3]);
		m.set("a", 1); // unchanged
		m.set("a", 5);
		expect(a).toHaveBeenCalledTimes(2);
		m.clear();
		expect([a, hasB, size].map((f) => f.mock.calls.length)).toEqual([3, 3, 4]);
	});

	it("tracks iteration", () => {
		const m = observable(new Map([["x", 1]]));
		const seen: string[] = [];
		autorun(() => {
			seen.push([...m].map(([k, v]) => `${k}=${v}`).join(","));
		});
		m.set("y", 2);
		m.delete("x");
		expect(seen).toEqual(["x=1", "x=1,y=2", "y=2"]);
		expect(JSON.stringify(m)).toBe(JSON.stringify([["y", 2]]));
	});
});

describe("observable sets", () => {
	it("tracks has, size and iteration", () => {
		const s = observable.set([1]);
		expect(s).toBeInstanceOf(ObservableSet);
		const has2 = vi.fn(() => s.has(2));
		const values = vi.fn(() => [...s].join());
		autorun(has2);
		autorun(values);
		s.add(3);
		expect([has2, values].map((f) => f.mock.calls.length)).toEqual([1, 2]);
		s.add(2);
		s.add(2);
		expect([has2, values].map((f) => f.mock.calls.length)).toEqual([2, 3]);
		s.delete(2);
		expect(values).toHaveLastReturnedWith("1,3");
	});
});

describe("deep Maps and Sets", () => {
	it("makes Map / Set values of observable objects observable", () => {
		const store = observable({
			tags: new Set<string>(),
			byId: new Map<string, number>(),
		});
		expect(store.tags).toBeInstanceOf(ObservableSet);
		const seen: number[] = [];
		autorun(() => {
			seen.push(store.tags.size + store.byId.size);
		});
		store.tags.add("a");
		store.byId = new Map([
			["x", 1],
			["y", 2],
		]);
		expect(store.byId).toBeInstanceOf(ObservableMap);
		expect(seen).toEqual([0, 1, 3]);
	});

	it("does so for ProxyLike (compiled) objects too, but not for observable.ref", () => {
		const p = new ProxyLike({ m: new Map<string, number>() });
		expect(p.get("m")).toBeInstanceOf(ObservableMap);
		p.set("m", new Map());
		expect(p.get("m")).toBeInstanceOf(ObservableMap);
		const r = makeObservable({ m: new Map() }, { m: observable.ref });
		expect(r.m).not.toBeInstanceOf(ObservableMap);
	});
});

describe("when", () => {
	it("runs the effect once when the predicate becomes true", () => {
		const s = new ProxyLike({ n: 0 });
		const effect = vi.fn();
		when(() => s.get("n") > 1, effect);
		s.set("n", 1);
		s.set("n", 2);
		s.set("n", 3);
		expect(effect).toHaveBeenCalledTimes(1);
	});

	it("runs immediately if already true, and can be disposed", () => {
		const s = new ProxyLike({ ok: true });
		const effect = vi.fn();
		when(() => s.get("ok"), effect);
		expect(effect).toHaveBeenCalledTimes(1);
		const other = vi.fn();
		const dispose = when(() => !s.get("ok"), other);
		dispose();
		s.set("ok", false);
		expect(other).not.toHaveBeenCalled();
	});

	it("returns a promise without an effect, with timeout and cancel", async () => {
		const s = new ProxyLike({ ready: false });
		const ready = when(() => s.get("ready"));
		s.set("ready", true);
		await expect(ready).resolves.toBeUndefined();

		await expect(when(() => false, { timeout: 5 })).rejects.toThrow(
			"WHEN_TIMEOUT",
		);

		const cancelled = when(() => false);
		cancelled.cancel();
		await expect(cancelled).rejects.toThrow("WHEN_CANCELLED");
	});
});

describe("flow", () => {
	it("runs each step as an action and resolves with the return value", async () => {
		const s = new ProxyLike({ loading: false, data: 0, steps: 0 });
		const runs = vi.fn(() => s.get("loading") || s.get("data"));
		autorun(runs);
		const load = flow(function* (n: number) {
			s.set("loading", true);
			s.set("steps", 1);
			const value = (yield Promise.resolve(n * 2)) as number;
			s.set("data", value);
			s.set("loading", false);
			return value;
		});
		await expect(load(21)).resolves.toBe(42);
		// Initially, then once per step (each step's writes are batched).
		expect(runs).toHaveBeenCalledTimes(3);
		expect(s.get("data")).toBe(42);
	});

	it("propagates errors into the generator and rejects when uncaught", async () => {
		const caught = flow(function* () {
			try {
				yield Promise.reject(new Error("nope"));
			} catch {
				return "recovered";
			}
		});
		await expect(caught()).resolves.toBe("recovered");
		const failing = flow(function* () {
			yield Promise.reject(new Error("nope"));
		});
		await expect(failing()).rejects.toThrow("nope");
	});

	it("can be cancelled", async () => {
		const after = vi.fn();
		const slow = flow(function* () {
			yield new Promise((r) => setTimeout(r, 10));
			after();
		});
		const promise = slow();
		promise.cancel();
		const error = await promise.catch((e: unknown) => e);
		expect(isFlowCancellationError(error)).toBe(true);
		await new Promise((r) => setTimeout(r, 20));
		expect(after).not.toHaveBeenCalled();
	});

	it("is inferred for generator methods, and works as an annotation", async () => {
		class Store {
			items: string[] = [];
			constructor() {
				makeAutoObservable(this);
			}
			*load() {
				this.items = (yield Promise.resolve(["a"])) as string[];
			}
		}
		const store = new Store();
		await store.load();
		expect(store.items).toEqual(["a"]);

		class Explicit {
			n = 0;
			constructor() {
				makeObservable(this, { n: observable, bump: flow.bound });
			}
			*bump() {
				yield Promise.resolve();
				this.n++;
			}
		}
		const e = new Explicit();
		const { bump } = e;
		await bump();
		expect(e.n).toBe(1);
	});
});
