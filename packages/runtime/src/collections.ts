/**
 * Observable arrays, boxes, Maps and Sets, plus `comparer`, and {@link enhance}: how deep
 * observables convert the values put into them (plain objects, arrays, Maps and Sets become
 * observable, as in MobX). Arrays are normally behind a `Proxy` (see `proxies.ts`).
 */
import {
	$mobx,
	adopt,
	checkWriteIf,
	convertingTo,
	DEV,
	Dep,
	debugName,
	deepEqual,
	type Equals,
	endBatch,
	globalState,
	maybeProxy,
	type Named,
	notifyOwners,
	type Owner,
	observableValues,
	ownersObserved,
	proxyOf,
	rawOf,
	release,
	reportChanged,
	reportObserved,
	startBatch,
	stringifyKey,
	untracked,
} from "./core.js";
import {
	collections,
	type Enhancer,
	isPlainObject,
	type ValueOptions,
	valueHandling,
} from "./enhance.js";
import {
	addInterceptor,
	addListener,
	type ChangeListener,
	type Hooks,
	type Interceptor,
	interceptChange,
	isSpying,
	type Lambda,
	report,
	spyReportEnd,
	spyReportStart,
} from "./spy.js";
import type {
	IInterceptor,
	IMapDidChange,
	IMapWillChange,
	ISetDidChange,
	ISetWillChange,
} from "./types.js";

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

function batched(fn: () => void): void {
	startBatch();
	try {
		fn();
	} finally {
		endBatch();
	}
}

// -- arrays ---------------------------------------------------------------------------------

export interface ArrayOptions extends ValueOptions {
	/** For debugging. */
	name?: string;
	/** `false`: don't put this array behind a `Proxy`. */
	proxy?: boolean;
}

const ARRAY = Symbol("sobx.array");

/** Splices of more items than this are not spread into a call. */
const MAX_SPREAD = 10000;

/** What's behind an observable array. */
export class ArrayAdministration implements Hooks, Named {
	interceptors: Interceptor[] | null = null;
	listeners: ChangeListener[] | null = null;
	readonly dep: Dep;
	readonly place: string | undefined;
	/** The owner this array is to the values it holds (array elements). */
	readonly owner: Owner;

	constructor(
		readonly array: ObservableArray<unknown>,
		readonly name: string,
		readonly prepare: Enhancer,
		readonly equals: Equals,
	) {
		this.dep = new Dep(undefined, name);
		this.place = DEV ? `${name}[..]` : undefined;
		this.owner = {
			ownerChanged: () => this.changed(),
			ownerObserved: () =>
				this.dep.observers.size > 0 || ownersObserved(this.array),
		};
	}

	/** Reads are recorded on it. */
	get atom(): Dep {
		return this.dep;
	}

	get object(): unknown {
		return proxyOf(this.array);
	}

	checkWrite(): void {
		if (!DEV || globalState.allowStateChanges) return;
		checkWriteIf(this.owner.ownerObserved(), this);
	}

	changed(): void {
		startBatch();
		try {
			reportChanged(this.dep);
			notifyOwners(this.array);
		} finally {
			endBatch();
		}
	}

	intercept(handler: Interceptor): Lambda {
		return addInterceptor(this, handler);
	}

	observe(listener: ChangeListener, fireImmediately = false): Lambda {
		if (fireImmediately) {
			const added = values(this.array);
			listener({
				observableKind: "array",
				object: this.object,
				debugObjectName: this.name,
				type: "splice",
				index: 0,
				added,
				addedCount: added.length,
				removed: [],
				removedCount: 0,
			});
		}
		return addListener(this, listener);
	}

	/** Every change of several elements. Returns the removed values. */
	splice(
		start: number | undefined,
		deleteCount: number,
		items: unknown[],
	): unknown[] {
		const { array } = this;
		this.checkWrite();
		const length = array.length;
		let index = start === undefined ? 0 : Math.trunc(start) || 0;
		if (index > length) index = length;
		else if (index < 0) index = Math.max(0, length + index);
		let count = Math.max(0, Math.min(deleteCount, length - index));
		let added = items;
		if (this.interceptors !== null) {
			const change = interceptChange(this, {
				object: this.object,
				type: "splice",
				index,
				removedCount: count,
				added,
			});
			if (!change) return [];
			count = change.removedCount;
			added = change.added;
		}
		added = added.map((item) => {
			const value = this.prepare(item, this.place);
			adopt(value, this.owner);
			return value;
		});
		const removed = spliceRaw(array, index, count, added);
		for (const value of removed) release(value, this.owner);
		if (count !== 0 || added.length !== 0) {
			report(
				this,
				() => ({
					observableKind: "array",
					object: this.object,
					debugObjectName: this.name,
					type: "splice",
					index,
					removed,
					added,
					removedCount: removed.length,
					addedCount: added.length,
				}),
				() => this.changed(),
			);
		}
		return removed;
	}

	/** `array[index] = value`. */
	set(index: number, value: unknown): void {
		const { array } = this;
		const length = array.length;
		if (index >= length) {
			// As in MobX, no sparse arrays: what's in between is undefined.
			const items = new Array(index + 1 - length).fill(undefined);
			items[items.length - 1] = value;
			this.splice(length, 0, items);
			return;
		}
		const previous = array[index];
		let next = value;
		if (this.interceptors !== null) {
			this.checkWrite();
			const change = interceptChange(this, {
				type: "update",
				object: this.object,
				index,
				newValue: value,
			});
			if (!change) return;
			next = change.newValue;
		}
		next = this.prepare(next, this.place);
		if (this.equals(previous, next)) return;
		if (this.interceptors === null) this.checkWrite();
		release(previous, this.owner);
		array[index] = next;
		adopt(next, this.owner);
		this.notifyUpdate(index, next, previous);
	}

	private notifyUpdate(index: number, newValue: unknown, oldValue: unknown) {
		report(
			this,
			() => ({
				observableKind: "array",
				object: this.object,
				type: "update",
				debugObjectName: this.name,
				index,
				newValue,
				oldValue,
			}),
			() => this.changed(),
		);
	}

	setLength(length: number): void {
		if (typeof length !== "number" || Number.isNaN(length) || length < 0) {
			throw new Error(`sobx: Out of range: ${length}`);
		}
		const current = this.array.length;
		if (length > current) {
			this.splice(current, 0, new Array(length - current).fill(undefined));
		} else if (length < current) {
			this.splice(length, current - length, []);
		}
	}
}

function administrationOf(value: unknown): ArrayAdministration | undefined {
	return (value as { [ARRAY]?: ArrayAdministration } | null | undefined)?.[
		ARRAY
	];
}

export { administrationOf as arrayAdministrationOf };

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
const call = (name: string, array: unknown, args: unknown[]) =>
	(arrayPrototype[name] as (...a: unknown[]) => unknown).apply(array, args);

/** A plain copy of what's in an observable array. */
function values(array: ObservableArray<unknown>): unknown[] {
	return call("slice", array, []) as unknown[];
}

function spliceRaw(
	array: ObservableArray<unknown>,
	index: number,
	count: number,
	items: unknown[],
): unknown[] {
	if (items.length < MAX_SPREAD) {
		return call("splice", array, [index, count, ...items]) as unknown[];
	}
	const removed = call("slice", array, [index, index + count]) as unknown[];
	const rest = call("slice", array, [index + count]) as unknown[];
	array.length += items.length - count;
	for (let i = 0; i < items.length; i++) array[index + i] = items[i];
	for (let i = 0; i < rest.length; i++) {
		array[index + items.length + i] = rest[i];
	}
	return removed;
}

/**
 * An observable array: a real `Array` (a subclass), so `Array.isArray`, `JSON.stringify`,
 * spreading and libraries keep working. Like MobX, it is tracked as a whole: every read depends
 * on it, every mutating method notifies once. It's normally behind a `Proxy` (see `proxies.ts`),
 * which observes `array.length` and `array[i]`; methods run on the array itself.
 *
 * Without a proxy (`useProxies: "never"`), `array.length` and `array[i]` are plain properties:
 * reads through an observable property are still tracked (the array notifies its owners), and
 * writes need {@link ObservableArray.set} / {@link ObservableArray.setLength} or a method.
 */
// biome-ignore lint/suspicious/noExplicitAny: as in MobX
export class ObservableArray<T = any> extends Array<T> {
	/** Derived arrays (`map`, `filter`, `slice`, ...) are plain arrays. */
	static override get [Symbol.species](): ArrayConstructor {
		return Array;
	}

	get [$mobx](): ArrayAdministration | undefined {
		return administrationOf(rawOf(this));
	}

	/** Read element `index` (tracked). */
	get(index: number): T | undefined {
		const self = rawOf(this);
		observeRawArray(self);
		return self[index];
	}

	/** Write element `index` (notifies), like `array[index] = value`. */
	set(index: number, value: T): T {
		const self = rawOf(this);
		const adm = administrationOf(self);
		if (!adm) {
			self[index] = value;
			return value;
		}
		if (!Number.isInteger(index) || index < 0) {
			throw new RangeError(`sobx: invalid array index ${index}.`);
		}
		adm.set(index, value);
		return self[index] as T;
	}

	/** Set the length (notifies), like `array.length = length`. */
	setLength(length: number): number {
		const self = rawOf(this);
		const adm = administrationOf(self);
		if (adm) adm.setLength(length);
		else self.length = length;
		return length;
	}

	/** Remove every element; returns them. */
	clear(): T[] {
		const self = rawOf(this);
		return this.spliceWithArray(0, self.length, []);
	}

	/** Replace every element; returns the old ones. */
	replace(items: T[]): T[] {
		const self = rawOf(this);
		return this.spliceWithArray(0, self.length, items);
	}

	/** Remove the first occurrence of `value`; returns whether there was one. */
	remove(value: T): boolean {
		const self = rawOf(this);
		const index = call("indexOf", self, [value]) as number;
		if (index < 0) return false;
		this.spliceWithArray(index, 1, []);
		return true;
	}

	/** Like `splice`, with the items as an array. */
	spliceWithArray(
		...args: [index: number, deleteCount?: number, items?: T[]]
	): T[] {
		// As in MobX: no count removes nothing (unlike `splice`).
		const [index, deleteCount, items = []] = args;
		const self = rawOf(this);
		const adm = administrationOf(self);
		const count = deleteCount ?? 0;
		if (!adm) {
			return call("splice", self, [index, count, ...items]) as T[];
		}
		return adm.splice(index, count, items) as T[];
	}

	toJSON(): T[] {
		return this.slice();
	}

	/** @internal `delete array[index]` (leaves a hole; notifies). */
	deleteIndex(index: number): boolean {
		const self = rawOf(this);
		const adm = administrationOf(self);
		if (!adm || !Object.hasOwn(self, index)) return delete self[index];
		adm.checkWrite();
		release(self[index], adm.owner);
		delete self[index];
		adm.changed();
		return true;
	}

	/** @internal `Object.defineProperty(array, key, descriptor)` (notifies). */
	defineKey(key: PropertyKey, descriptor: PropertyDescriptor): boolean {
		const self = rawOf(this);
		const adm = administrationOf(self);
		adm?.checkWrite();
		const defined = Reflect.defineProperty(self, key, descriptor);
		if (defined) adm?.changed();
		return defined;
	}
}

/** @internal {@link observeArray} for the array itself (not a proxy of it). */
export function observeRawArray(array: ObservableArray<unknown>): void {
	if (globalState.tracking === null && (!DEV || globalState.allowStateReads)) {
		return;
	}
	const adm = administrationOf(array);
	if (adm) reportObserved(adm.dep);
}

/** @internal Depend on an observable array (as its reading methods do). */
export function observeArray(array: ObservableArray<unknown>): void {
	observeRawArray(rawOf(array));
}

/** A mutating method. `run` gets the array itself; `this` is returned in its place. */
function defineMutator(
	name: string,
	run: (
		adm: ArrayAdministration,
		array: ObservableArray<unknown>,
		args: unknown[],
	) => unknown,
): void {
	Object.defineProperty(ObservableArray.prototype, name, {
		value: function (this: ObservableArray<unknown>, ...args: unknown[]) {
			const self = rawOf(this);
			const adm = administrationOf(self);
			if (!adm) return call(name, self, args);
			const result = run(adm, self, args);
			return result === self ? this : result;
		},
		writable: true,
		configurable: true,
	});
}

defineMutator("push", (adm, array, items) => {
	adm.splice(array.length, 0, items);
	return array.length;
});
defineMutator("unshift", (adm, array, items) => {
	adm.splice(0, 0, items);
	return array.length;
});
defineMutator("pop", (adm, array) => {
	return adm.splice(Math.max(array.length - 1, 0), 1, [])[0];
});
defineMutator("shift", (adm) => adm.splice(0, 1, [])[0]);
defineMutator("splice", (adm, _array, args) => {
	// splice() removes nothing; splice(start) removes to the end.
	if (args.length === 0) return [];
	const count =
		args.length === 1
			? Number.POSITIVE_INFINITY
			: Math.trunc(args[1] as number) || 0;
	return adm.splice(args[0] as number, count, args.slice(2));
});
for (const name of ["sort", "reverse"]) {
	defineMutator(name, (adm, array, args) => {
		if (globalState.tracking !== null) {
			throw new Error(
				`sobx: \`observableArray.${name}()\` mutates the array in-place, which is not allowed inside a derivation. Use \`array.slice().${name}()\` instead`,
			);
		}
		const copy = values(array);
		call(name, copy, args);
		adm.splice(0, array.length, copy);
		return array;
	});
}
for (const name of ["fill", "copyWithin"]) {
	defineMutator(name, (adm, array, args) => {
		// Element by element, as MobX's proxies do, notifying once.
		const copy = values(array);
		call(name, copy, args);
		batched(() => {
			for (let i = 0; i < copy.length; i++) adm.set(i, copy[i]);
		});
		return array;
	});
}

/** Methods taking a callback, and which of its arguments is the array. */
const CALLBACK_ARRAY_ARGUMENT: Record<string, number | undefined> = {
	every: 2,
	filter: 2,
	find: 2,
	findIndex: 2,
	findLast: 2,
	findLastIndex: 2,
	flatMap: 2,
	forEach: 2,
	map: 2,
	reduce: 3,
	reduceRight: 3,
	some: 2,
};

// Reading methods depend on the array.
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
	const arrayArgument = CALLBACK_ARRAY_ARGUMENT[name as string];
	Object.defineProperty(ObservableArray.prototype, name, {
		value: function (this: ObservableArray<unknown>, ...args: unknown[]) {
			const self = rawOf(this);
			observeRawArray(self);
			const callback = args[0];
			if (self !== this && arrayArgument && typeof callback === "function") {
				// Callbacks get the array (last argument): the proxy, not the array behind it.
				const array = this;
				args[0] = function (this: unknown, ...values: unknown[]) {
					values[arrayArgument] = array;
					return callback.apply(this, values);
				};
			}
			return builtin.apply(self, args);
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
	const { enhancer, equals } = valueHandling(options);
	const adm = new ArrayAdministration(
		array as ObservableArray<unknown>,
		options.name ?? debugName("ObservableArray"),
		enhancer,
		equals,
	);
	Object.defineProperty(array, ARRAY, { value: adm });
	observableValues.add(array);
	const observable =
		options.proxy === false ? array : maybeProxy(array, "array");
	convertingTo(values, observable, () => {
		const initial = Array.from(values as Iterable<T>);
		if (initial.length === 0) return;
		const items = initial.map((item) => {
			const value = adm.prepare(item, adm.place);
			adopt(value, adm.owner);
			return value;
		});
		spliceRaw(array as ObservableArray<unknown>, 0, 0, items);
		if (isSpying()) {
			spyReportStart({
				observableKind: "array",
				object: observable,
				debugObjectName: adm.name,
				type: "splice",
				index: 0,
				removed: [],
				added: items,
				removedCount: 0,
				addedCount: items.length,
			});
			spyReportEnd();
		}
	});
	return observable;
}

export interface BoxOptions<T> extends ValueOptions {
	/** Decides whether a new value counts as a change. Default `Object.is`. */
	equals?: (a: T, b: T) => boolean;
	/** For debugging. */
	name?: string;
}

// -- Maps and Sets --------------------------------------------------------------------------

export interface CollectionOptions extends ValueOptions {
	/** For debugging. */
	name?: string;
}

/** What a Map can be made from. */
export type MapEntries<K, V> =
	| Iterable<readonly [K, V]>
	| Record<string, V>
	| null
	| undefined;

function entriesOf<K, V>(entries: MapEntries<K, V>): Iterable<readonly [K, V]> {
	if (entries === null || entries === undefined) return [];
	if (Symbol.iterator in entries) return entries;
	if (isPlainObject(entries)) {
		return Reflect.ownKeys(entries)
			.filter((key) => Object.prototype.propertyIsEnumerable.call(entries, key))
			.map(
				(key) =>
					[key, (entries as Record<PropertyKey, V>)[key]] as unknown as [K, V],
			);
	}
	throw new Error(`sobx: Cannot initialize from ${String(entries)}`);
}

/** One entry of a Map, for `observe(map, key, ...)` and `intercept(map, key, ...)`. */
class MapEntry<K, V> implements Hooks, Named {
	interceptors: Interceptor[] | null = null;
	listeners: ChangeListener[] | null = null;
	constructor(
		readonly map: ObservableMap<K, V>,
		readonly key: K,
		readonly atom: Dep,
	) {}
	get name(): string {
		return this.atom.name;
	}
	get(): V | undefined {
		return this.map.get(this.key);
	}
	set(value: V): void {
		this.map.set(this.key, value);
	}
	intercept(handler: Interceptor): Lambda {
		return addInterceptor(this, handler);
	}
	observe(listener: ChangeListener, fireImmediately?: boolean): Lambda {
		if (fireImmediately) {
			listener({
				observableKind: "value",
				debugObjectName: this.name,
				object: this,
				type: "update",
				newValue: untracked(() => this.get()),
				oldValue: undefined,
			});
		}
		return addListener(this, listener);
	}
}

/**
 * An observable Map. `get` / `has` track the key (including keys not present yet); `size` and
 * `keys()` track the keys, other iteration the whole map.
 */
// biome-ignore lint/suspicious/noExplicitAny: as in MobX
export class ObservableMap<K = any, V = any>
	extends Map<K, V>
	implements Hooks, Named
{
	readonly name: string;
	interceptors: Interceptor[] | null = null;
	listeners: ChangeListener[] | null = null;
	private keyDeps: Map<K, Dep> | undefined;
	/** Per key: whether it exists (`has()`), changed only when the key is added or deleted. */
	private hasDeps: Map<K, Dep> | undefined;
	private entryHooks: Map<K, MapEntry<K, V>> | undefined;
	/** The set of keys (and their order). */
	private readonly keysDep: Dep;
	/** All values. */
	private readonly all: Dep;
	private readonly prepare: Enhancer;
	private readonly equals: Equals;
	/** Owner of the values: a held array / object changing notifies the whole map. */
	private readonly owner: Owner = {
		ownerChanged: () => reportChanged(this.all),
		ownerObserved: () => this.all.observers.size > 0,
	};

	constructor(entries?: MapEntries<K, V>, options: CollectionOptions = {}) {
		super();
		this.name = options.name ?? debugName("ObservableMap");
		this.keysDep = new Dep(undefined, this, "keys()");
		this.all = new Dep(undefined, this);
		const { enhancer, equals } = valueHandling(options);
		this.prepare = enhancer;
		this.equals = equals;
		observableValues.add(this);
		convertingTo(entries, this, () => {
			for (const [k, v] of entriesOf(entries)) {
				const value = this.prepare(v, this, k);
				adopt(value, this.owner);
				super.set(k, value);
				if (isSpying()) this.reportAdded(k, value);
			}
		});
	}

	get [$mobx](): this {
		return this;
	}

	get atom(): Dep {
		return this.keysDep;
	}

	/** @internal The dependency of `get(key)` (if `key` is in the map, or `create`). */
	depOf(key: K): Dep {
		this.keyDeps ??= new Map();
		let dep = this.keyDeps.get(key);
		if (!dep) {
			dep = new Dep(undefined, this, key);
			this.keyDeps.set(key, dep);
		}
		return dep;
	}

	/** @internal For `observe(map, key, ...)`. */
	entry(key: K): MapEntry<K, V> | undefined {
		if (!super.has(key)) return undefined;
		this.entryHooks ??= new Map();
		let entry = this.entryHooks.get(key);
		if (!entry) {
			entry = new MapEntry(this, key, this.depOf(key));
			this.entryHooks.set(key, entry);
		}
		return entry;
	}

	/** @internal The dependency of `has(key)`, if something read it. */
	presenceOf(key: K): Dep | undefined {
		return this.hasDeps?.get(key);
	}

	private observeKey(key: K): void {
		if (
			globalState.tracking === null &&
			(!DEV || globalState.allowStateReads)
		) {
			return;
		}
		reportObserved(this.depOf(key));
	}

	private observeAll(): void {
		reportObserved(this.keysDep);
		reportObserved(this.all);
	}

	private check(key: K, added: boolean): void {
		if (!DEV || globalState.allowStateChanges) return;
		const dep = this.keyDeps?.get(key);
		checkWriteIf(
			(dep?.observers.size ?? 0) > 0 ||
				this.all.observers.size > 0 ||
				(added &&
					(this.keysDep.observers.size > 0 ||
						(this.hasDeps?.get(key)?.observers.size ?? 0) > 0)),
			dep ?? this,
		);
	}

	private changed(key: K, presence: boolean): void {
		batched(() => {
			const dep = this.keyDeps?.get(key);
			if (dep) reportChanged(dep);
			if (presence) {
				const hasDep = this.hasDeps?.get(key);
				if (hasDep) reportChanged(hasDep);
				reportChanged(this.keysDep);
			}
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
				dep = new Dep(undefined, `${this.name}.${stringifyKey(key)}?`);
				this.hasDeps.set(key, dep);
			}
			reportObserved(dep);
		}
		return super.has(key);
	}

	override set(key: K, value: V): this {
		const existed = super.has(key);
		let given = value;
		if (this.interceptors !== null) {
			const change = interceptChange(this, {
				type: existed ? "update" : "add",
				object: this,
				newValue: value,
				name: key,
			});
			if (!change) return this;
			given = change.newValue;
		}
		const entry = this.entryHooks?.get(key);
		if (existed && entry?.interceptors) {
			const change = interceptChange(entry, {
				object: entry,
				type: "update",
				newValue: given,
			});
			if (!change) return this;
			given = change.newValue;
		}
		const next = this.prepare(given, this, key);
		const previous = super.get(key);
		if (existed && this.equals(previous, next)) return this;
		this.check(key, !existed);
		const apply = () => {
			release(previous, this.owner);
			super.set(key, next);
			adopt(next, this.owner);
			this.changed(key, !existed);
			if (entry?.listeners) {
				for (const listener of [...entry.listeners]) {
					listener({
						type: "update",
						object: entry,
						newValue: next,
						oldValue: previous,
					});
				}
			}
		};
		if (existed) {
			report(
				this,
				() => ({
					observableKind: "map",
					debugObjectName: this.name,
					type: "update",
					object: this,
					oldValue: previous,
					name: key,
					newValue: next,
				}),
				apply,
			);
		} else {
			apply();
			this.reportAdded(key, next);
		}
		return this;
	}

	private reportAdded(key: K, value: V): void {
		report(
			this,
			() => ({
				observableKind: "map",
				debugObjectName: this.name,
				type: "add",
				object: this,
				name: key,
				newValue: value,
			}),
			() => {},
		);
	}

	override delete(key: K): boolean {
		if (this.interceptors !== null) {
			const change = interceptChange(this, {
				type: "delete",
				object: this,
				name: key,
			});
			if (!change) return false;
		}
		if (!super.has(key)) return false;
		this.check(key, true);
		const previous = super.get(key);
		report(
			this,
			() => ({
				observableKind: "map",
				debugObjectName: this.name,
				type: "delete",
				object: this,
				oldValue: previous,
				name: key,
			}),
			() => {
				release(previous, this.owner);
				super.delete(key);
				this.entryHooks?.delete(key);
				this.changed(key, true);
			},
		);
		return true;
	}

	override clear(): void {
		batched(() => {
			untracked(() => {
				for (const key of [...super.keys()]) this.delete(key);
			});
		});
	}

	/** Set every entry of `other` (a Map, entries, or a plain object). */
	merge(other?: MapEntries<K, V>): this {
		const entries = untracked(() => [...entriesOf(other)]);
		batched(() => {
			for (const [key, value] of entries) this.set(key, value);
		});
		return this;
	}

	/** Make the entries those of `other`, in its order. */
	replace(other: MapEntries<K, V>): this {
		const entries = untracked(() => [...entriesOf(other)]);
		batched(() => {
			const wanted = new Map(entries);
			const before = [...super.keys()];
			let keysChanged = false;
			const order: K[] = [];
			for (const key of before) {
				if (wanted.has(key)) continue;
				// Interceptors may refuse.
				if (this.delete(key)) keysChanged = true;
				else order.push(key);
			}
			for (const [key, value] of wanted) {
				const existed = super.has(key);
				this.set(key, value);
				if (!super.has(key)) continue;
				order.push(key);
				if (!existed) keysChanged = true;
			}
			// Put them in order.
			const current = [...super.keys()];
			if (order.some((key, i) => !Object.is(key, current[i]))) {
				const data = new Map(super.entries());
				super.clear();
				for (const key of order) super.set(key, data.get(key) as V);
				if (!keysChanged) {
					reportChanged(this.keysDep);
					reportChanged(this.all);
				}
			}
		});
		return this;
	}

	getOrInsert(key: K, value: V): V {
		if (!this.has(key)) this.set(key, value);
		return this.get(key) as V;
	}

	getOrInsertComputed(key: K, callback: (key: K) => V): V {
		if (!this.has(key)) this.set(key, callback(key));
		return this.get(key) as V;
	}

	override get size(): number {
		// The native Map constructor runs before the fields are set.
		if (this.keysDep) reportObserved(this.keysDep);
		return super.size;
	}

	override forEach(
		fn: (value: V, key: K, map: Map<K, V>) => void,
		thisArg?: unknown,
	): void {
		this.observeAll();
		super.forEach(fn, thisArg);
	}

	override keys(): MapIterator<K> {
		reportObserved(this.keysDep);
		return super.keys();
	}

	override values(): MapIterator<V> {
		this.observeAll();
		return super.values();
	}

	override entries(): MapIterator<[K, V]> {
		this.observeAll();
		return super.entries();
	}

	override [Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries();
	}

	observe(
		listener: (change: IMapDidChange<K, V>) => void,
		fireImmediately?: boolean,
	): Lambda {
		if (fireImmediately) {
			throw new Error(
				"sobx: `observe` doesn't support fireImmediately=true in combination with maps.",
			);
		}
		return addListener(this, listener as ChangeListener);
	}

	intercept(handler: IInterceptor<IMapWillChange<K, V>>): Lambda {
		return addInterceptor(this, handler as Interceptor);
	}

	toJSON(): Array<[K, V]> {
		return [...this.entries()];
	}

	override toString(): string {
		return "[object ObservableMap]";
	}
}

/** An observable Set. `has` tracks the value; `size` and iteration track the whole set. */
// biome-ignore lint/suspicious/noExplicitAny: as in MobX
export class ObservableSet<T = any> extends Set<T> implements Hooks, Named {
	readonly name: string;
	interceptors: Interceptor[] | null = null;
	listeners: ChangeListener[] | null = null;
	private valueDeps: Map<T, Dep> | undefined;
	private readonly all: Dep;
	private readonly prepare: Enhancer;
	private readonly owner: Owner = {
		ownerChanged: () => reportChanged(this.all),
		ownerObserved: () => this.all.observers.size > 0,
	};

	constructor(values?: Iterable<T> | null, options: CollectionOptions = {}) {
		super();
		this.name = options.name ?? debugName("ObservableSet");
		this.all = new Dep(undefined, this);
		this.prepare = valueHandling(options).enhancer;
		observableValues.add(this);
		convertingTo(values, this, () => {
			if (!values) return;
			for (const v of values) {
				const value = this.prepare(v, this);
				adopt(value, this.owner);
				super.add(value);
				if (isSpying()) this.reportAdded(v);
			}
		});
	}

	get [$mobx](): this {
		return this;
	}

	get atom(): Dep {
		return this.all;
	}

	private changed(value: T): void {
		batched(() => {
			const dep = this.valueDeps?.get(value);
			if (dep) reportChanged(dep);
			reportChanged(this.all);
		});
	}

	private check(value: T): void {
		if (!DEV || globalState.allowStateChanges) return;
		checkWriteIf(
			this.all.observers.size > 0 ||
				(this.valueDeps?.get(value)?.observers.size ?? 0) > 0,
			this,
		);
	}

	override has(value: T): boolean {
		if (globalState.tracking !== null) {
			this.valueDeps ??= new Map();
			let dep = this.valueDeps.get(value);
			if (!dep) {
				dep = new Dep(undefined, this, value);
				this.valueDeps.set(value, dep);
			}
			reportObserved(dep);
		} else if (DEV && !globalState.allowStateReads && this.all) {
			reportObserved(this.all);
		}
		return super.has(value);
	}

	override add(value: T): this {
		let given = value;
		if (this.interceptors !== null) {
			const change = interceptChange(this, {
				type: "add",
				object: this,
				newValue: value,
			});
			if (!change) return this;
			given = change.newValue;
		}
		if (super.has(given)) return this;
		const next = this.prepare(given, this);
		if (super.has(next)) return this;
		this.check(next);
		super.add(next);
		adopt(next, this.owner);
		this.changed(next);
		this.reportAdded(given);
		return this;
	}

	private reportAdded(value: T): void {
		report(
			this,
			() => ({
				observableKind: "set",
				debugObjectName: this.name,
				type: "add",
				object: this,
				newValue: value,
			}),
			() => {},
		);
	}

	override delete(value: T): boolean {
		if (this.interceptors !== null) {
			const change = interceptChange(this, {
				type: "delete",
				object: this,
				oldValue: value,
			});
			if (!change) return false;
		}
		if (!super.has(value)) return false;
		this.check(value);
		report(
			this,
			() => ({
				observableKind: "set",
				debugObjectName: this.name,
				type: "delete",
				object: this,
				oldValue: value,
			}),
			() => {
				release(value, this.owner);
				super.delete(value);
				this.changed(value);
			},
		);
		return true;
	}

	override clear(): void {
		batched(() => {
			untracked(() => {
				for (const value of [...super.values()]) this.delete(value);
			});
		});
	}

	/** Make the values those of `other`. */
	replace(other: Iterable<T> | null | undefined): this {
		const values = untracked(() => (other ? [...other] : []));
		if (other === null || other === undefined) return this;
		batched(() => {
			this.clear();
			for (const value of values) this.add(value);
		});
		return this;
	}

	override get size(): number {
		if (this.all) reportObserved(this.all);
		return super.size;
	}

	override forEach(
		fn: (value: T, value2: T, set: Set<T>) => void,
		thisArg?: unknown,
	): void {
		reportObserved(this.all);
		super.forEach(fn, thisArg);
	}

	override keys(): SetIterator<T> {
		reportObserved(this.all);
		return super.keys();
	}

	override values(): SetIterator<T> {
		reportObserved(this.all);
		return super.values();
	}

	override entries(): SetIterator<[T, T]> {
		reportObserved(this.all);
		return super.entries();
	}

	override [Symbol.iterator](): SetIterator<T> {
		return this.values();
	}

	observe(
		listener: (change: ISetDidChange<T>) => void,
		fireImmediately?: boolean,
	): Lambda {
		if (fireImmediately) {
			throw new Error(
				"sobx: `observe` doesn't support fireImmediately=true in combination with sets.",
			);
		}
		return addListener(this, listener as ChangeListener);
	}

	intercept(handler: IInterceptor<ISetWillChange<T>>): Lambda {
		return addInterceptor(this, handler as Interceptor);
	}

	toJSON(): T[] {
		return [...this.values()];
	}

	override toString(): string {
		return "[object ObservableSet]";
	}
}

// The set operations read the whole set (natively they wouldn't be tracked).
for (const name of [
	"intersection",
	"union",
	"difference",
	"symmetricDifference",
	"isSubsetOf",
	"isSupersetOf",
	"isDisjointFrom",
]) {
	const builtin = (Set.prototype as unknown as Record<string, unknown>)[name];
	if (typeof builtin !== "function") continue;
	Object.defineProperty(ObservableSet.prototype, name, {
		value: function (this: ObservableSet<unknown>, other: unknown) {
			const argument =
				other instanceof ObservableSet || other instanceof ObservableMap
					? new Set(other instanceof ObservableSet ? other : other.keys())
					: other;
			return builtin.call(new Set(this), argument);
		},
		writable: true,
		configurable: true,
	});
}

collections.array = (value, deep, name) =>
	createObservableArray(value, { deep, name });
collections.map = (value, deep, name) =>
	new ObservableMap(value, { deep, name });
collections.set = (value, deep, name) =>
	new ObservableSet(value, { deep, name });
