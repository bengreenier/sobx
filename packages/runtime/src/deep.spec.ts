import {
	action,
	autorun,
	computed,
	configure,
	get as getKey,
	has as hasKey,
	isObservable,
	isObservableArray,
	isObservableMap,
	isObservableObject,
	isObservableSet,
	keys as keysOf,
	makeAutoObservable,
	makeObservable,
	ObservableArray,
	ObservableMap,
	observable,
	ProxyLike,
	reaction,
	remove,
	runInAction,
	set,
	toJS,
} from "./index.js";

/** Values seen by an autorun of `fn`, as JSON. */
function track(fn: () => unknown): string[] {
	const seen: string[] = [];
	autorun(() => {
		seen.push(JSON.stringify(fn()));
	});
	return seen;
}

describe("observable arrays", () => {
	it("are real arrays to the outside", () => {
		const a = observable([1, 2, 3]);
		expect(Array.isArray(a)).toBe(true);
		expect(isObservableArray(a)).toBe(true);
		expect(a.length).toBe(3);
		expect([...a]).toEqual([1, 2, 3]);
		expect(JSON.stringify(a)).toBe("[1,2,3]");
		expect(a.map((x) => x * 2)).toEqual([2, 4, 6]);
		expect(a.concat([4])).toEqual([1, 2, 3, 4]);
		expect(Object.keys(a)).toEqual(["0", "1", "2"]);
		expect(a.at(-1)).toBe(3);
		expect(a.includes(2)).toBe(true);
	});

	it("notifies on every kind of change", () => {
		const a = observable<number>([3, 1, 2]);
		const seen = track(() => a.join(","));
		runInAction(() => a.push(4));
		runInAction(() => a.pop());
		runInAction(() => a.unshift(0));
		runInAction(() => a.shift());
		runInAction(() => a.splice(1, 1, 9, 9));
		runInAction(() => a.sort());
		runInAction(() => a.reverse());
		runInAction(() => a.fill(7, 0, 1));
		runInAction(() => a.copyWithin(0, 3));
		// Index / length writes go through set / setLength (the compiler emits them).
		runInAction(() => a.set(0, 5));
		runInAction(() => a.setLength(2));
		runInAction(() => a.set(3, 8)); // past the end: grows with a hole
		expect(seen).toEqual([
			'"3,1,2"',
			'"3,1,2,4"',
			'"3,1,2"',
			'"0,3,1,2"',
			'"3,1,2"',
			'"3,9,9,2"',
			'"2,3,9,9"',
			'"9,9,3,2"',
			'"7,9,3,2"',
			'"2,9,3,2"',
			'"5,9,3,2"',
			'"5,9"',
			'"5,9,,8"',
		]);
	});

	it("ignores no-op changes", () => {
		const a = observable([1, 2]);
		const runs = vi.fn(() => a.length);
		autorun(runs);
		runInAction(() => {
			a.set(0, 1);
			a.setLength(2);
			a.push();
			a.splice(0, 0);
			(a.splice as () => number[])(); // no arguments: removes nothing
			a.pop.call(observable([]));
		});
		expect(runs).toHaveBeenCalledTimes(1);
	});

	it("batches a mutating method into one notification", () => {
		const a = observable([1, 2, 3]);
		const runs = vi.fn(() => a.join());
		autorun(runs);
		runInAction(() => a.splice(0, 3, 4, 5, 6, 7));
		expect(runs).toHaveBeenCalledTimes(2);
	});

	it("returns the observable array from sort / reverse / fill / copyWithin", () => {
		const a = observable([2, 1]);
		expect(a.sort()).toBe(a);
		expect(a.reverse()).toBe(a);
		expect(a.fill(0)).toBe(a);
		expect(a.copyWithin(0, 1)).toBe(a);
	});

	it("tracks reads through iteration and methods", () => {
		const a = observable([1, 2]);
		const sum = vi.fn(() => a.reduce((x, y) => x + y, 0));
		const iter = vi.fn(() => {
			let n = 0;
			for (const x of a) n += x;
			return n;
		});
		autorun(sum);
		autorun(iter);
		runInAction(() => a.push(3));
		expect(sum).toHaveLastReturnedWith(6);
		expect(iter).toHaveLastReturnedWith(6);
	});

	it("makes values deep (and not with deep: false)", () => {
		const a = observable([{ n: 1 }]);
		expect(isObservableObject(a[0])).toBe(true);
		runInAction(() => a.push({ n: 2 }));
		expect(isObservableObject(a[1])).toBe(true);
		const seen = track(() => a.map((x) => x.n));
		runInAction(() => {
			(a[0] as { n: number }).n = 10;
		});
		expect(seen).toEqual(["[1,2]", "[10,2]"]);

		const shallow = observable.array([{ n: 1 }], { deep: false });
		expect(isObservableObject(shallow[0])).toBe(false);
	});

	it("observable.array creates one", () => {
		const a = observable.array<string>();
		expect(a).toBeInstanceOf(ObservableArray);
		const seen = track(() => a.slice().length);
		runInAction(() => a.push("x"));
		expect(seen).toEqual(["0", "1"]);
	});

	it("is never a Proxy, and plain index / length reads aren't tracked on their own", () => {
		const a = observable([1]);
		expect(Object.getPrototypeOf(a)).toBe(ObservableArray.prototype);
		expect(structuredClone(a)).toEqual([1]); // proxies can't be cloned
		const direct = vi.fn(() => a.length);
		autorun(direct);
		runInAction(() => a.push(2));
		expect(direct).toHaveBeenCalledTimes(1); // the documented limitation
		const viaGet = track(() => [a.get(0), a.get(5)]);
		runInAction(() => a.set(0, 9));
		expect(viaGet).toEqual(["[1,null]", "[9,null]"]);
	});

	it("notifies the property holding it (index / length reads through a property are tracked)", () => {
		const store = observable({ items: [1, 2], nested: [[1]] });
		const seen = track(() => [
			store.items.length,
			store.items[0],
			store.nested[0]?.length,
		]);
		runInAction(() => store.items.push(3));
		runInAction(() => (store.items as ObservableArray<number>).set(0, 7));
		runInAction(() => store.nested[0]?.push(2)); // an array in an array
		expect(seen).toEqual(["[2,1,1]", "[3,1,1]", "[3,7,1]", "[3,7,2]"]);
	});

	it("stops notifying a property once the array is replaced", () => {
		const store = observable({ items: [1] });
		const old = store.items;
		const runs = vi.fn(() => store.items.length);
		autorun(runs);
		runInAction(() => {
			store.items = [2, 3];
		});
		runInAction(() => old.push(4));
		expect(runs).toHaveBeenCalledTimes(2);
	});
});

describe("observable objects", () => {
	it("are never a Proxy", () => {
		const o = observable({ a: 1 });
		expect(Object.getOwnPropertyDescriptor(o, "a")?.get).toBeTypeOf("function");
		expect(structuredClone(toJS(o))).toEqual({ a: 1 });
	});

	it("can be made from frozen objects (as MobX)", () => {
		const source = Object.freeze({ a: 1, nested: Object.freeze({ b: 2 }) });
		// The observable copy is writable, even though the source's type is readonly.
		const o = observable(source) as { a: number; nested: { b: number } };
		expect(o).not.toBe(source);
		expect(track(() => [o.a, o.nested.b])).toEqual(["[1,2]"]);
		const seen = track(() => o.nested.b);
		runInAction(() => {
			o.a = 3;
			o.nested.b = 4;
		});
		expect(seen).toEqual(["2", "4"]);
		expect(source).toEqual({ a: 1, nested: { b: 2 } });
	});

	it("track added and deleted keys through the explicit API", () => {
		const o = observable<Record<string, number>>({ a: 1 });
		const keys = track(() => keysOf(o));
		const hasB = track(() => hasKey(o, "b"));
		const b = track(() => getKey(o, "b") ?? null);
		runInAction(() => set(o, "b", 2));
		runInAction(() => remove(o, "a"));
		expect(keys).toEqual(['["a"]', '["a","b"]', '["b"]']);
		expect(hasB).toEqual(["false", "true"]);
		expect(b).toEqual(["null", "2"]);
		expect(o).toEqual({ b: 2 });
		runInAction(() => {
			o.b = 3; // added keys are observable properties
		});
		expect(b.at(-1)).toBe("3");
	});

	it("notify the property holding them when keys are added or removed", () => {
		const store = observable({ user: { name: "a" } as Record<string, string> });
		const seen = track(() => [
			store.user.nickname ?? null,
			Object.keys(store.user),
		]);
		runInAction(() => set(store.user, "nickname", "b"));
		runInAction(() => remove(store.user, "name"));
		expect(seen).toEqual([
			'[null,["name"]]',
			'["b",["name","nickname"]]',
			'["b",["nickname"]]',
		]);
	});

	it("set / remove / has / get / keys work on Maps, Sets and arrays too", () => {
		const m = observable.map<string, number>();
		set(m, "a", 1);
		expect(getKey(m, "a")).toBe(1);
		const a = observable([1, 2, 3]);
		set(a, 5, 6);
		expect(a.length).toBe(6);
		remove(a, 0);
		expect(toJS(a)).toEqual([2, 3, undefined, undefined, 6]);
		expect(keysOf(observable.set([1, 2]))).toEqual([1, 2]);
		expect(hasKey(a, 4)).toBe(true);
		expect(() => set({}, "a", 1)).toThrow(/expects an observable/);
	});

	it("make values deep: nested objects, arrays, Maps, Sets", () => {
		const store = observable({
			user: { name: "a", address: { city: "x" } },
			items: [1],
			byId: new Map<string, number>(),
			tags: new Set<string>(),
		});
		expect(isObservableObject(store.user)).toBe(true);
		expect(isObservableObject(store.user.address)).toBe(true);
		expect(isObservableArray(store.items)).toBe(true);
		expect(isObservableMap(store.byId)).toBe(true);
		expect(isObservableSet(store.tags)).toBe(true);

		const seen = track(() => [
			store.user.address.city,
			store.items.length,
			store.byId.size,
			store.tags.size,
		]);
		runInAction(() => {
			store.user.address.city = "y";
		});
		runInAction(() => store.items.push(2));
		runInAction(() => store.byId.set("k", 1));
		runInAction(() => store.tags.add("t"));
		runInAction(() => {
			store.user = { name: "b", address: { city: "z" } };
		});
		expect(isObservableObject(store.user)).toBe(true);
		expect(seen).toEqual([
			'["x",1,0,0]',
			'["y",1,0,0]',
			'["y",2,0,0]',
			'["y",2,1,0]',
			'["y",2,1,1]',
			'["z",2,1,1]',
		]);
	});

	it("respect ref / shallow / struct and deep: false", () => {
		const o = observable(
			{ ref: { a: 1 }, shallow: [{ a: 1 }], struct: { a: 1 }, deep: { a: 1 } },
			{
				ref: observable.ref,
				shallow: observable.shallow,
				struct: observable.struct,
			},
		);
		expect(isObservable(o.ref)).toBe(false);
		expect(isObservableArray(o.shallow)).toBe(true);
		expect(isObservable(o.shallow[0])).toBe(false);
		expect(isObservable(o.struct)).toBe(false);
		expect(isObservable(o.deep)).toBe(true);
		const runs = vi.fn(() => o.struct);
		autorun(runs);
		runInAction(() => {
			o.struct = { a: 1 };
		});
		expect(runs).toHaveBeenCalledTimes(1);

		const flat = observable({ nested: { a: 1 } }, {}, { deep: false });
		expect(isObservable(flat.nested)).toBe(false);
	});

	it("run getters as cached computeds and methods as actions, with this = the proxy", () => {
		const getter = vi.fn(function (this: { n: number }) {
			return this.n * 2;
		});
		const o = observable({
			n: 1,
			get double(): number {
				return getter.call(this);
			},
			set double(v: number) {
				this.n = v / 2;
			},
			bump() {
				this.n++;
				this.n++;
			},
		});
		const seen = track(() => [o.double, o.double]);
		o.bump();
		o.double = 20;
		expect(seen).toEqual(["[2,2]", "[6,6]", "[20,20]"]);
		expect(getter).toHaveBeenCalledTimes(3);
		expect(Object.keys(o)).toEqual(["n", "bump"]);
		expect(toJS(o)).toEqual({ n: 10 });
	});

	it("reject assignment to a computed without a setter", () => {
		const o = observable({
			get x() {
				return 1;
			},
		});
		expect(() => {
			(o as { x: number }).x = 2;
		}).toThrow(TypeError);
	});

	it("accept and ignore the proxy option", () => {
		const o = observable({ a: 1 }, {}, { proxy: true });
		expect(isObservableObject(o)).toBe(true);
		const seen = track(() => o.a);
		runInAction(() => {
			o.a = 2;
		});
		expect(seen).toEqual(["1", "2"]);
	});
});

describe("cyclic and shared values", () => {
	it("convert to the same observable", () => {
		type Node = { name: string; self?: Node; peer?: Node; list?: Node[] };
		const a: Node = { name: "a" };
		a.self = a;
		const b: Node = { name: "b", peer: a, list: [a] };
		const o = observable({ a, b, both: [a, b] });
		expect(o.a.self).toBe(o.a);
		expect(o.b.peer).toBe(o.a);
		expect(o.b.list?.[0]).toBe(o.a);
		expect(o.both[0]).toBe(o.a);
		expect(o.both[1]).toBe(o.b);
		const cyclicArray: unknown[] = [];
		cyclicArray.push(cyclicArray);
		const arr = observable(cyclicArray);
		expect(arr[0]).toBe(arr);
		const m = new Map<string, unknown>();
		m.set("m", m);
		const om = observable(m);
		expect(om.get("m")).toBe(om);
	});
});

describe("classes and ProxyLike are deep too", () => {
	it("makeAutoObservable converts array fields", () => {
		class Todos {
			items: { title: string; done: boolean }[] = [];
			constructor() {
				makeAutoObservable(this);
			}
			get remaining() {
				return this.items.filter((t) => !t.done).length;
			}
			add(title: string) {
				this.items.push({ title, done: false });
			}
			toggle(i: number) {
				const item = this.items[i];
				if (item) item.done = !item.done;
			}
		}
		const todos = new Todos();
		const seen = track(() => todos.remaining);
		todos.add("a");
		todos.add("b");
		todos.toggle(0);
		expect(seen).toEqual(["0", "1", "2", "1"]);
	});

	it("makeObservable with observable.ref keeps values as they are", () => {
		class Store {
			list = [1];
			constructor() {
				makeObservable(this, { list: observable.ref });
			}
		}
		expect(isObservableArray(new Store().list)).toBe(false);
	});

	it("ProxyLike values are deep", () => {
		const p = new ProxyLike({ items: [1], user: { name: "a" } });
		expect(isObservableArray(p.get("items"))).toBe(true);
		const seen = track(() => [p.get("items").length, p.get("user").name]);
		runInAction(() => {
			p.get("items").push(2);
			p.get("user").name = "b";
		});
		expect(seen).toEqual(['[1,"a"]', '[2,"b"]']);
	});
});

describe("toJS", () => {
	it("converts observables back to plain values, deeply", () => {
		const store = observable({
			items: [{ n: 1 }],
			byId: new Map([["a", { n: 2 }]]),
			tags: new Set(["t"]),
			get count() {
				return this.items.length;
			},
			add() {},
		});
		const plain = toJS(store);
		expect(plain).toEqual({
			items: [{ n: 1 }],
			byId: new Map([["a", { n: 2 }]]),
			tags: new Set(["t"]),
		});
		expect(isObservable(plain)).toBe(false);
		expect(isObservable(plain.items)).toBe(false);
		expect(isObservable(plain.items[0])).toBe(false);
		expect(plain.byId).not.toBeInstanceOf(ObservableMap);
	});

	it("handles ProxyLike, classes and cycles", () => {
		expect(toJS(new ProxyLike({ a: [1] }))).toEqual({ a: [1] });
		class C {
			x = 1;
			constructor() {
				makeAutoObservable(this);
			}
		}
		expect(toJS(new C())).toEqual({ x: 1 });
		const cyclic = observable<{ self?: unknown; n: number }>({ n: 1 });
		runInAction(() => {
			cyclic.self = cyclic;
		});
		const plain = toJS(cyclic) as { self: unknown };
		expect(plain.self).toBe(plain);
	});
});

describe("enforceActions", () => {
	afterEach(() => configure({ enforceActions: "observed" }));

	it('warns for observed changes outside actions ("observed", the default)', () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const s = observable({ a: 1, b: 1 });
		runInAction(() => {
			s.b = 2; // fine
		});
		s.b = 3; // unobserved: fine
		autorun(() => s.a);
		s.a = 2; // observed, outside an action
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(
			/enforceActions is "observed".*: a/,
		);
		action(() => {
			s.a = 3;
		})();
		reaction(
			() => s.a,
			() => {
				s.b = 9; // effects are actions
			},
		);
		runInAction(() => {
			s.a = 4;
		});
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('"always" warns for any change; "never" for none', () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		configure({ enforceActions: "always" });
		const a = observable([1]);
		a.push(2);
		expect(warn).toHaveBeenCalledTimes(1);
		configure({ enforceActions: "never" });
		autorun(() => a.length);
		a.push(3);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("warns about unsupported configure options", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		configure({ computedRequiresReaction: true } as never);
		expect(warn.mock.calls[0]?.[0]).toMatch(/computedRequiresReaction/);
		warn.mockRestore();
	});
});

describe("computed with deep values", () => {
	it("recomputes when nested values change", () => {
		const store = observable({ todos: [{ done: false }] });
		const remaining = computed(() => store.todos.filter((t) => !t.done).length);
		const seen = track(() => remaining.get());
		runInAction(() => {
			(store.todos[0] as { done: boolean }).done = true;
		});
		runInAction(() => store.todos.push({ done: false }));
		expect(seen).toEqual(["1", "0", "1"]);
	});
});
