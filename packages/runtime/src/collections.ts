/**
 * Observable boxes, Maps and Sets, plus `comparer`. Like MobX, putting a plain Map or Set into
 * a (deep) observable property makes it observable too ({@link enhance}).
 */
import {
	Dep,
	deepEqual,
	type Equals,
	endBatch,
	globalState,
	reportChanged,
	startBatch,
} from "./core.js";

/** Equality functions, as in MobX. */
export const comparer = {
	/** `Object.is` (the default everywhere). */
	default: (a: unknown, b: unknown): boolean => Object.is(a, b),
	/** `===`. */
	identity: (a: unknown, b: unknown): boolean => a === b,
	/** Deep structural equality. */
	structural: deepEqual,
	/** Equal if the same, or plain objects / arrays with the same (`Object.is`) entries. */
	shallow: (a: unknown, b: unknown): boolean => {
		if (Object.is(a, b)) return true;
		if (typeof a !== "object" || typeof b !== "object" || !a || !b)
			return false;
		if (Array.isArray(a)) {
			return (
				Array.isArray(b) &&
				a.length === b.length &&
				a.every((x, i) => Object.is(x, b[i]))
			);
		}
		const ka = Object.keys(a);
		return (
			ka.length === Object.keys(b).length &&
			ka.every((k) =>
				Object.is(
					(a as Record<string, unknown>)[k],
					(b as Record<string, unknown>)[k],
				),
			)
		);
	},
};

/** Make a plain Map / Set observable (other values are returned as they are). */
export function enhance<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	if (value instanceof Map && !(value instanceof ObservableMap)) {
		return new ObservableMap(value) as T;
	}
	if (value instanceof Set && !(value instanceof ObservableSet)) {
		return new ObservableSet(value) as T;
	}
	return value;
}

function observe(dep: Dep): void {
	globalState.tracking?.deps.add(dep);
}

function batched(fn: () => void): void {
	startBatch();
	try {
		fn();
	} finally {
		endBatch();
	}
}

export interface BoxOptions<T> {
	/** Decides whether a new value counts as a change. Default `Object.is`. */
	equals?: (a: T, b: T) => boolean;
	/** Make a Map / Set value observable. Default `true`. */
	deep?: boolean;
	/** For debugging; not used. */
	name?: string;
}

/** `observable.box(value)`: a single observable value, read with `get()` and written with `set()`. */
export class ObservableBox<T> {
	private readonly dep = new Dep();
	private readonly equals: Equals;
	private readonly deep: boolean;
	private value: T;

	constructor(value: T, options: BoxOptions<T> = {}) {
		this.equals = (options.equals as Equals | undefined) ?? Object.is;
		this.deep = options.deep ?? true;
		this.value = this.deep ? enhance(value) : value;
	}

	get(): T {
		observe(this.dep);
		return this.value;
	}

	set(value: T): void {
		const next = this.deep ? enhance(value) : value;
		if (this.equals(this.value, next)) return;
		this.value = next;
		reportChanged(this.dep);
	}
}

export interface CollectionOptions {
	/** Make Map / Set values observable. Default `true`. */
	deep?: boolean;
	/** For debugging; not used. */
	name?: string;
}

/**
 * An observable Map. `get` / `has` track the key (including keys not present yet); `size` and
 * iteration track the whole map.
 */
export class ObservableMap<K, V> extends Map<K, V> {
	private keyDeps: Map<K, Dep> | undefined;
	private readonly all = new Dep();
	private readonly deep: boolean;

	constructor(
		entries?: Iterable<readonly [K, V]> | null,
		options: CollectionOptions = {},
	) {
		super();
		this.deep = options.deep ?? true;
		if (entries) for (const [k, v] of entries) super.set(k, this.enhance(v));
	}

	private enhance(value: V): V {
		return this.deep ? enhance(value) : value;
	}

	private observeKey(key: K): void {
		if (globalState.tracking === null) return;
		this.keyDeps ??= new Map();
		let dep = this.keyDeps.get(key);
		if (!dep) {
			dep = new Dep();
			this.keyDeps.set(key, dep);
		}
		globalState.tracking.deps.add(dep);
	}

	private changed(key: K): void {
		batched(() => {
			const dep = this.keyDeps?.get(key);
			if (dep) reportChanged(dep);
			reportChanged(this.all);
		});
	}

	override get(key: K): V | undefined {
		this.observeKey(key);
		return super.get(key);
	}

	override has(key: K): boolean {
		this.observeKey(key);
		return super.has(key);
	}

	override set(key: K, value: V): this {
		const next = this.enhance(value);
		const had = super.has(key);
		if (had && Object.is(super.get(key), next)) return this;
		super.set(key, next);
		this.changed(key);
		return this;
	}

	override delete(key: K): boolean {
		if (!super.delete(key)) return false;
		this.changed(key);
		return true;
	}

	override clear(): void {
		if (super.size === 0) return;
		const keys = [...super.keys()];
		super.clear();
		batched(() => {
			for (const key of keys) {
				const dep = this.keyDeps?.get(key);
				if (dep) reportChanged(dep);
			}
			reportChanged(this.all);
		});
	}

	override get size(): number {
		observe(this.all);
		return super.size;
	}

	override forEach(
		fn: (value: V, key: K, map: Map<K, V>) => void,
		thisArg?: unknown,
	): void {
		observe(this.all);
		super.forEach(fn, thisArg);
	}

	override keys(): MapIterator<K> {
		observe(this.all);
		return super.keys();
	}

	override values(): MapIterator<V> {
		observe(this.all);
		return super.values();
	}

	override entries(): MapIterator<[K, V]> {
		observe(this.all);
		return super.entries();
	}

	override [Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries();
	}

	toJSON(): Array<[K, V]> {
		return [...this.entries()];
	}
}

/** An observable Set. `has` tracks the value; `size` and iteration track the whole set. */
export class ObservableSet<T> extends Set<T> {
	private valueDeps: Map<T, Dep> | undefined;
	private readonly all = new Dep();
	private readonly deep: boolean;

	constructor(values?: Iterable<T> | null, options: CollectionOptions = {}) {
		super();
		this.deep = options.deep ?? true;
		if (values) for (const v of values) super.add(this.deep ? enhance(v) : v);
	}

	private changed(value: T): void {
		batched(() => {
			const dep = this.valueDeps?.get(value);
			if (dep) reportChanged(dep);
			reportChanged(this.all);
		});
	}

	override has(value: T): boolean {
		if (globalState.tracking !== null) {
			this.valueDeps ??= new Map();
			let dep = this.valueDeps.get(value);
			if (!dep) {
				dep = new Dep();
				this.valueDeps.set(value, dep);
			}
			globalState.tracking.deps.add(dep);
		}
		return super.has(value);
	}

	override add(value: T): this {
		const next = this.deep ? enhance(value) : value;
		if (super.has(next)) return this;
		super.add(next);
		this.changed(next);
		return this;
	}

	override delete(value: T): boolean {
		if (!super.delete(value)) return false;
		this.changed(value);
		return true;
	}

	override clear(): void {
		if (super.size === 0) return;
		const values = [...super.values()];
		super.clear();
		batched(() => {
			for (const value of values) {
				const dep = this.valueDeps?.get(value);
				if (dep) reportChanged(dep);
			}
			reportChanged(this.all);
		});
	}

	override get size(): number {
		observe(this.all);
		return super.size;
	}

	override forEach(
		fn: (value: T, value2: T, set: Set<T>) => void,
		thisArg?: unknown,
	): void {
		observe(this.all);
		super.forEach(fn, thisArg);
	}

	override keys(): SetIterator<T> {
		observe(this.all);
		return super.keys();
	}

	override values(): SetIterator<T> {
		observe(this.all);
		return super.values();
	}

	override entries(): SetIterator<[T, T]> {
		observe(this.all);
		return super.entries();
	}

	override [Symbol.iterator](): SetIterator<T> {
		return this.values();
	}

	toJSON(): T[] {
		return [...this.values()];
	}
}
