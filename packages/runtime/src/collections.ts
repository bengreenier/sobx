/**
 * Observable arrays, boxes, Maps and Sets, plus `comparer`, and {@link enhance}: how deep
 * observables convert the values put into them (plain objects, arrays, Maps and Sets become
 * observable, as in MobX). No `Proxy` is used anywhere.
 */
import {
	adopt,
	checkWrite,
	checkWriteIf,
	converting,
	convertingTo,
	Dep,
	deepEqual,
	type Equals,
	endBatch,
	globalState,
	hooks,
	markObservable,
	notifyOwners,
	type Owner,
	observableValues,
	ownersObserved,
	release,
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

export function isPlainObject(value: unknown): value is object {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto === Object.prototype || proto === null) return true;
	// An object literal from another realm (an iframe, node:vm), as MobX accepts: its prototype
	// is that realm's Object.prototype.
	return (
		Object.getPrototypeOf(proto) === null &&
		typeof proto.constructor === "function" &&
		proto.constructor.name === "Object" &&
		!Array.isArray(value)
	);
}

/**
 * Make `value` observable if it is a plain object, array, Map or Set that isn't already
 * (other values are returned as they are). `deep`: whether the new observable's own values
 * are converted too (`false` for `observable.shallow`).
 */
export function enhance<T>(value: T, deep = true): T {
	if (typeof value !== "object" || value === null) return value;
	if (observableValues.has(value)) return value;
	const inProgress = converting.get(value);
	if (inProgress) return inProgress as T;
	if (Array.isArray(value)) {
		return createObservableArray(value, { deep }) as T;
	}
	if (value instanceof Map) return new ObservableMap(value, { deep }) as T;
	if (value instanceof Set) return new ObservableSet(value, { deep }) as T;
	if (isPlainObject(value)) return hooks.object(value, deep) as T;
	return value;
}

const identity = <T>(value: T): T => value;
/** The value converter for a collection's contents. */
const enhancerOf = (deep: boolean) =>
	deep ? <T>(value: T): T => enhance(value) : identity;

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

// -- arrays ---------------------------------------------------------------------------------

export interface ArrayOptions {
	/** Make values put into the array observable. Default `true`. */
	deep?: boolean;
	/** For debugging; not used. */
	name?: string;
}

const ARRAY = Symbol("sobx.array");

interface ArrayAdministration {
	readonly dep: Dep;
	readonly prepare: <V>(value: V) => V;
	/** The owner this array is to the values it holds (array elements). */
	readonly owner: Owner;
}

function administrationOf(value: unknown): ArrayAdministration | undefined {
	return (value as { [ARRAY]?: ArrayAdministration } | null | undefined)?.[
		ARRAY
	];
}

export function isObservableArray(
	value: unknown,
): value is ObservableArray<unknown> {
	return value instanceof ObservableArray;
}

const MAX_INDEX = 4294967294;
/** Whether `key` is an array index (`"0"`, `"1"`, ...). */
export function isIndexKey(key: PropertyKey): boolean {
	if (typeof key === "number") return Number.isInteger(key) && key >= 0;
	if (typeof key !== "string") return false;
	if (key === "0") return true;
	const c = key.charCodeAt(0);
	if (c < 49 || c > 57) return false; // "1".."9"
	for (let i = 1; i < key.length; i++) {
		const d = key.charCodeAt(i);
		if (d < 48 || d > 57) return false;
	}
	return Number(key) <= MAX_INDEX;
}

const arrayPrototype = Array.prototype as unknown as Record<
	PropertyKey,
	(...args: unknown[]) => unknown
>;

/**
 * An observable array: a real `Array` (a subclass, never a `Proxy`), so `Array.isArray`,
 * `JSON.stringify`, spreading and libraries keep working. Like MobX, it is tracked as a whole:
 * every reading method and iteration depends on it, every mutating method notifies once.
 *
 * `array.length` and `array[i]` are plain properties and can't be observed. Reads through an
 * observable property are still tracked (the array notifies its owners: `store.items.length`
 * re-runs when `store.items` changes), and the sobx compiler turns index and `length` writes it
 * can follow into {@link ObservableArray.set} / {@link ObservableArray.setLength}. Elsewhere,
 * use `get(i)`, `set(i, value)`, `setLength(n)` or the methods.
 */
export class ObservableArray<T> extends Array<T> {
	/** Derived arrays (`map`, `filter`, `slice`, ...) are plain arrays. */
	static override get [Symbol.species](): ArrayConstructor {
		return Array;
	}

	/** Read element `index` (tracked). */
	get(index: number): T | undefined {
		const adm = administrationOf(this);
		if (adm) observe(adm.dep);
		return this[index];
	}

	/** Write element `index` (notifies), like `array[index] = value`. */
	set(index: number, value: T): T {
		const adm = administrationOf(this);
		if (!adm) {
			this[index] = value;
			return value;
		}
		if (!Number.isInteger(index) || index < 0) {
			throw new RangeError(`sobx: invalid array index ${index}.`);
		}
		const next = adm.prepare(value);
		if (index < this.length && Object.is(this[index], next)) return next;
		checkArrayWrite(this, adm);
		release(this[index], adm.owner);
		this[index] = next;
		adopt(next, adm.owner);
		arrayChanged(this, adm);
		return next;
	}

	/** Set the length (notifies), like `array.length = length`. */
	setLength(length: number): number {
		const adm = administrationOf(this);
		if (!adm || this.length === length) {
			this.length = length;
			return length;
		}
		checkArrayWrite(this, adm);
		for (let i = length; i < this.length; i++) release(this[i], adm.owner);
		this.length = length;
		arrayChanged(this, adm);
		return length;
	}

	/** @internal `delete array[index]` (leaves a hole; notifies). */
	deleteIndex(index: number): boolean {
		const adm = administrationOf(this);
		if (!adm || !Object.hasOwn(this, index)) return delete this[index];
		checkArrayWrite(this, adm);
		release(this[index], adm.owner);
		delete this[index];
		arrayChanged(this, adm);
		return true;
	}
}
markObservable(ObservableArray.prototype);

/** @internal Depend on an observable array (as its reading methods do). */
export function observeArray(array: ObservableArray<unknown>): void {
	const adm = administrationOf(array);
	if (adm) observe(adm.dep);
}

function checkArrayWrite(array: object, adm: ArrayAdministration): void {
	checkWriteIf(
		adm.dep.observers.size > 0 || ownersObserved(array),
		"an observable array",
	);
}

function arrayChanged(array: object, adm: ArrayAdministration): void {
	startBatch();
	try {
		reportChanged(adm.dep);
		notifyOwners(array);
	} finally {
		endBatch();
	}
}

/** A mutating method: converts inserted values, notifies once if something changed. */
function defineMutator(
	name: string,
	run: (
		array: ObservableArray<unknown>,
		adm: ArrayAdministration,
		args: unknown[],
	) => { result: unknown; changed: boolean },
): void {
	const builtin = arrayPrototype[name] as (...args: unknown[]) => unknown;
	Object.defineProperty(ObservableArray.prototype, name, {
		value: function (this: ObservableArray<unknown>, ...args: unknown[]) {
			const adm = administrationOf(this);
			if (!adm) return builtin.apply(this, args);
			checkArrayWrite(this, adm);
			let outcome!: { result: unknown; changed: boolean };
			startBatch();
			try {
				outcome = run(this, adm, args);
				if (outcome.changed) arrayChanged(this, adm);
			} finally {
				endBatch();
			}
			return outcome.result;
		},
		writable: true,
		configurable: true,
	});
}

function insert(adm: ArrayAdministration, items: unknown[]): unknown[] {
	return items.map((item) => {
		const value = adm.prepare(item);
		adopt(value, adm.owner);
		return value;
	});
}

const push = arrayPrototype.push as (...items: unknown[]) => number;

defineMutator("push", (array, adm, items) => ({
	result: push.apply(array, insert(adm, items)),
	changed: items.length > 0,
}));
defineMutator("unshift", (array, adm, items) => ({
	result: (arrayPrototype.unshift as (...items: unknown[]) => number).apply(
		array,
		insert(adm, items),
	),
	changed: items.length > 0,
}));
defineMutator("pop", (array, adm) => {
	if (array.length === 0) return { result: undefined, changed: false };
	const value = arrayPrototype.pop?.call(array);
	release(value, adm.owner);
	return { result: value, changed: true };
});
defineMutator("shift", (array, adm) => {
	if (array.length === 0) return { result: undefined, changed: false };
	const value = arrayPrototype.shift?.call(array);
	release(value, adm.owner);
	return { result: value, changed: true };
});
defineMutator("splice", (array, adm, args) => {
	// splice() removes nothing; splice(start) removes to the end.
	if (args.length === 0) return { result: [], changed: false };
	const items = args.length > 2 ? insert(adm, args.slice(2)) : [];
	const removed = (
		arrayPrototype.splice as (...args: unknown[]) => unknown[]
	).apply(array, args.length < 2 ? [args[0]] : [args[0], args[1], ...items]);
	for (const value of removed) release(value, adm.owner);
	return { result: removed, changed: removed.length > 0 || items.length > 0 };
});
for (const name of ["sort", "reverse"]) {
	defineMutator(name, (array, _adm, args) => {
		(arrayPrototype[name] as (...args: unknown[]) => unknown).apply(
			array,
			args,
		);
		return { result: array, changed: array.length > 1 };
	});
}
defineMutator("fill", (array, adm, [value, start, end]) => {
	const next = adm.prepare(value);
	adopt(next, adm.owner);
	(arrayPrototype.fill as (...args: unknown[]) => unknown).call(
		array,
		next,
		start,
		end,
	);
	return { result: array, changed: array.length > 0 };
});
defineMutator("copyWithin", (array, _adm, args) => {
	(arrayPrototype.copyWithin as (...args: unknown[]) => unknown).apply(
		array,
		args,
	);
	return { result: array, changed: array.length > 0 };
});

// Reading methods depend on the array (`length` and `[i]` can't; see ObservableArray).
for (const name of [
	"at",
	"concat",
	"entries",
	"every",
	"filter",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"flat",
	"flatMap",
	"forEach",
	"includes",
	"indexOf",
	"join",
	"keys",
	"lastIndexOf",
	"map",
	"reduce",
	"reduceRight",
	"slice",
	"some",
	"toLocaleString",
	"toReversed",
	"toSorted",
	"toSpliced",
	"toString",
	"values",
	"with",
	Symbol.iterator,
] as PropertyKey[]) {
	const builtin = arrayPrototype[name];
	if (typeof builtin !== "function") continue;
	Object.defineProperty(ObservableArray.prototype, name, {
		value: function (this: ObservableArray<unknown>, ...args: unknown[]) {
			const adm = administrationOf(this);
			if (adm) observe(adm.dep);
			return builtin.apply(this, args);
		},
		writable: true,
		configurable: true,
	});
}

/** An observable array holding `values` (converted if `deep`). */
export function createObservableArray<T>(
	values: Iterable<T> | ArrayLike<T> = [],
	options: ArrayOptions = {},
): ObservableArray<T> {
	const array = new ObservableArray<T>();
	const adm: ArrayAdministration = {
		dep: new Dep(),
		prepare: enhancerOf(options.deep ?? true),
		owner: {
			ownerChanged: () => arrayChanged(array, adm),
			ownerObserved: () => adm.dep.observers.size > 0 || ownersObserved(array),
		},
	};
	Object.defineProperty(array, ARRAY, { value: adm });
	observableValues.add(array);
	convertingTo(values, array, () => {
		push.apply(array, insert(adm, Array.from(values as Iterable<T>)));
	});
	return array;
}

// -- boxes ----------------------------------------------------------------------------------

export interface BoxOptions<T> {
	/** Decides whether a new value counts as a change. Default `Object.is`. */
	equals?: (a: T, b: T) => boolean;
	/** Make the value observable (plain objects, arrays, Maps, Sets). Default `true`. */
	deep?: boolean;
	/** For debugging; not used. */
	name?: string;
}

/** `observable.box(value)`: a single observable value, read with `get()` and written with `set()`. */
export class ObservableBox<T> {
	private readonly dep = new Dep();
	private readonly equals: Equals;
	private readonly prepare: <V>(value: V) => V;
	private readonly owner: Owner = {
		ownerChanged: () => reportChanged(this.dep),
		ownerObserved: () => this.dep.observers.size > 0,
	};
	private value: T;

	constructor(value: T, options: BoxOptions<T> = {}) {
		this.equals = (options.equals as Equals | undefined) ?? Object.is;
		this.prepare = enhancerOf(options.deep ?? true);
		this.value = this.prepare(value);
		adopt(this.value, this.owner);
		observableValues.add(this);
	}

	get(): T {
		observe(this.dep);
		return this.value;
	}

	set(value: T): void {
		const next = this.prepare(value);
		if (this.equals(this.value, next)) return;
		checkWrite(this.dep, "an observable box");
		release(this.value, this.owner);
		this.value = next;
		adopt(next, this.owner);
		reportChanged(this.dep);
	}

	toJSON(): T {
		return this.get();
	}
}

// -- Maps and Sets --------------------------------------------------------------------------

export interface CollectionOptions {
	/** Make values put into the collection observable. Default `true`. */
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
	/** Per key: whether it exists (`has()`), changed only when the key is added or deleted. */
	private hasDeps: Map<K, Dep> | undefined;
	private readonly all = new Dep();
	private readonly prepare: <T>(value: T) => T;
	/** Owner of the values: a held array / object changing notifies the whole map. */
	private readonly owner: Owner = {
		ownerChanged: () => reportChanged(this.all),
		ownerObserved: () => this.all.observers.size > 0,
	};

	constructor(
		entries?: Iterable<readonly [K, V]> | null,
		options: CollectionOptions = {},
	) {
		super();
		this.prepare = enhancerOf(options.deep ?? true);
		observableValues.add(this);
		convertingTo(entries, this, () => {
			if (!entries) return;
			for (const [k, v] of entries) {
				const value = this.prepare(v);
				adopt(value, this.owner);
				super.set(k, value);
			}
		});
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

	private check(key: K): void {
		const dep = this.keyDeps?.get(key);
		checkWrite(
			dep && dep.observers.size > 0 ? dep : this.all,
			"an observable Map",
		);
	}

	private changed(key: K, presence: boolean): void {
		batched(() => {
			const dep = this.keyDeps?.get(key);
			if (dep) reportChanged(dep);
			const hasDep = presence ? this.hasDeps?.get(key) : undefined;
			if (hasDep) reportChanged(hasDep);
			reportChanged(this.all);
		});
	}

	override get(key: K): V | undefined {
		this.observeKey(key);
		return super.get(key);
	}

	/** Tracked: re-runs what read it when `key` is added or deleted (as in MobX). */
	override has(key: K): boolean {
		if (globalState.tracking !== null) {
			this.hasDeps ??= new Map();
			let dep = this.hasDeps.get(key);
			if (!dep) {
				dep = new Dep();
				this.hasDeps.set(key, dep);
			}
			globalState.tracking.deps.add(dep);
		}
		return super.has(key);
	}

	override set(key: K, value: V): this {
		const next = this.prepare(value);
		const existed = super.has(key);
		if (existed && Object.is(super.get(key), next)) return this;
		this.check(key);
		release(super.get(key), this.owner);
		super.set(key, next);
		adopt(next, this.owner);
		this.changed(key, !existed);
		return this;
	}

	override delete(key: K): boolean {
		if (!super.has(key)) return false;
		this.check(key);
		release(super.get(key), this.owner);
		super.delete(key);
		this.changed(key, true);
		return true;
	}

	override clear(): void {
		if (super.size === 0) return;
		checkWrite(this.all, "an observable Map");
		const keys = [...super.keys()];
		for (const value of super.values()) release(value, this.owner);
		super.clear();
		batched(() => {
			for (const key of keys) {
				const dep = this.keyDeps?.get(key);
				if (dep) reportChanged(dep);
				const hasDep = this.hasDeps?.get(key);
				if (hasDep) reportChanged(hasDep);
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
	private readonly prepare: <V>(value: V) => V;
	private readonly owner: Owner = {
		ownerChanged: () => reportChanged(this.all),
		ownerObserved: () => this.all.observers.size > 0,
	};

	constructor(values?: Iterable<T> | null, options: CollectionOptions = {}) {
		super();
		this.prepare = enhancerOf(options.deep ?? true);
		observableValues.add(this);
		convertingTo(values, this, () => {
			if (!values) return;
			for (const v of values) {
				const value = this.prepare(v);
				adopt(value, this.owner);
				super.add(value);
			}
		});
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
		const next = this.prepare(value);
		if (super.has(next)) return this;
		checkWrite(this.all, "an observable Set");
		super.add(next);
		adopt(next, this.owner);
		this.changed(next);
		return this;
	}

	override delete(value: T): boolean {
		if (!super.has(value)) return false;
		const dep = this.valueDeps?.get(value);
		checkWrite(
			dep && dep.observers.size > 0 ? dep : this.all,
			"an observable Set",
		);
		release(value, this.owner);
		super.delete(value);
		this.changed(value);
		return true;
	}

	override clear(): void {
		if (super.size === 0) return;
		checkWrite(this.all, "an observable Set");
		const values = [...super.values()];
		for (const value of values) release(value, this.owner);
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
