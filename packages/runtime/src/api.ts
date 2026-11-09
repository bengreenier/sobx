/**
 * sobx's explicit API for observables (`set`, `remove`, `has`, `get`, `keys`, `values`,
 * `entries`; same names and semantics as MobX's object API functions), and the lenient helpers
 * the compiler emits for property operations it rewrites (`getProperty`, `setProperty`, ...).
 *
 * sobx never uses `Proxy`, so adding or deleting keys of an observable object, `in`,
 * `Object.keys` and array index / `length` writes are not observed on their own: they go through
 * these functions, which the compiler emits for the code it can see.
 */
import {
	isIndexKey,
	ObservableArray,
	ObservableMap,
	ObservableSet,
	observeArray,
} from "./collections.js";
import { endBatch, startBatch } from "./core.js";
import {
	addObservableProperty,
	administrationOf,
	removeObservableProperty,
} from "./observable.js";
import { ProxyLike } from "./proxy-like.js";

type AnyRecord = Record<PropertyKey, unknown>;

function fail(api: string, target: unknown): never {
	throw new TypeError(
		`sobx: ${api}() expects an observable object, array, Map or Set; got ${typeof target === "object" ? Object.prototype.toString.call(target) : typeof target}.`,
	);
}

function index(key: unknown): number {
	return typeof key === "number" ? key : Number.parseInt(String(key), 10);
}

/** Set `key` of an observable object (adding it as an observable property if new), Map or array. */
export function set<V>(
	target: Map<PropertyKey, V>,
	values: Record<string, V>,
): void;
export function set<K, V>(target: Map<K, V>, key: K, value: V): void;
export function set<T>(target: Set<T>, value: T): void;
export function set<T>(target: T[], index: number, value: T): void;
export function set<T extends object>(
	target: T,
	values: Record<string, unknown>,
): void;
export function set<T extends object>(
	target: T,
	key: PropertyKey,
	value: unknown,
): void;
export function set(...args: [unknown, unknown, unknown?]): void {
	const [target, key, value] = args;
	if (args.length === 2 && !(target instanceof ObservableSet)) {
		startBatch();
		try {
			for (const k in key as AnyRecord)
				set(target as object, k, (key as AnyRecord)[k]);
		} finally {
			endBatch();
		}
		return;
	}
	if (target instanceof ObservableMap) {
		target.set(key, value);
	} else if (target instanceof ObservableSet) {
		target.add(key);
	} else if (target instanceof ObservableArray) {
		const i = index(key);
		if (!(i >= 0)) throw new RangeError(`sobx: invalid index ${String(key)}.`);
		target.set(i, value);
	} else if (target instanceof ProxyLike) {
		(target as ProxyLike<AnyRecord>).set(key as PropertyKey, value);
	} else if (
		typeof target === "object" &&
		target !== null &&
		administrationOf(target)
	) {
		if ((key as PropertyKey) in target)
			(target as AnyRecord)[key as PropertyKey] = value;
		else addObservableProperty(target, key as PropertyKey, value);
	} else {
		fail("set", target);
	}
}

/** Delete `key` from an observable object, Map or Set, or remove element `index` of an array. */
export function remove(target: object, key: unknown): void {
	if (target instanceof ObservableMap || target instanceof ObservableSet) {
		target.delete(key);
	} else if (target instanceof ObservableArray) {
		target.splice(index(key), 1);
	} else if (target instanceof ProxyLike) {
		(target as ProxyLike<AnyRecord>).delete(key as PropertyKey);
	} else if (administrationOf(target)) {
		if (Object.hasOwn(target, key as PropertyKey)) {
			removeObservableProperty(target, key as PropertyKey);
		}
	} else {
		fail("remove", target);
	}
}

/** Whether an observable object / Map / Set has `key`, or an array has `index`. Tracked. */
export function has(target: object, key: unknown): boolean {
	if (target instanceof ObservableMap || target instanceof ObservableSet) {
		return target.has(key);
	}
	if (target instanceof ObservableArray) {
		observeArray(target);
		const i = index(key);
		return i >= 0 && i < target.length;
	}
	if (target instanceof ProxyLike) {
		return (target as ProxyLike<AnyRecord>).has(key as PropertyKey);
	}
	const adm = administrationOf(target);
	if (!adm) fail("has", target);
	return (
		adm.has(key as PropertyKey) || Object.hasOwn(target, key as PropertyKey)
	);
}

/** Read `key` of an observable object / Map, or `index` of an array. Tracked, including keys that don't exist yet. */
export function get(target: object, key: unknown): unknown {
	if (target instanceof ObservableMap) return target.get(key);
	if (target instanceof ObservableArray) {
		return has(target, key) ? target[index(key)] : undefined;
	}
	if (target instanceof ProxyLike) {
		return (target as ProxyLike<AnyRecord>).get(key as PropertyKey);
	}
	const adm = administrationOf(target);
	if (!adm) fail("get", target);
	if ((key as PropertyKey) in target)
		return (target as AnyRecord)[key as PropertyKey];
	return adm.get(key as PropertyKey);
}

/** The keys of an observable object (its observable properties), Map or Set, or an array's indexes. Tracked. */
export function keys(target: object): unknown[] {
	if (target instanceof ObservableMap || target instanceof ObservableSet) {
		return Array.from(target.keys());
	}
	if (target instanceof ObservableArray) return target.map((_, i) => i);
	if (target instanceof ProxyLike)
		return (target as ProxyLike<AnyRecord>).keys();
	const adm = administrationOf(target);
	if (!adm) fail("keys", target);
	return adm.keys();
}

/** The values of an observable object, Map, Set or array. Tracked. */
export function values(target: object): unknown[] {
	if (target instanceof ObservableMap || target instanceof ObservableSet) {
		return Array.from(target.values());
	}
	if (target instanceof ObservableArray) return target.slice();
	return keys(target).map((key) => get(target, key));
}

/** The `[key, value]` pairs of an observable object, Map, Set or array. Tracked. */
export function entries(target: object): Array<[unknown, unknown]> {
	if (target instanceof ObservableMap || target instanceof ObservableSet) {
		return Array.from(target.entries());
	}
	if (target instanceof ObservableArray) return target.map((v, i) => [i, v]);
	return keys(target).map((key) => [key, get(target, key)]);
}

// -- compiler helpers -----------------------------------------------------------------------
// Emitted by @sobx/compiler for property operations on values it knows may be observable. They
// fall back to the plain JavaScript operation for anything else.

const isObservableObjectLike = (target: unknown): target is object =>
	typeof target === "object" &&
	target !== null &&
	(target instanceof ProxyLike || administrationOf(target) !== undefined);

/** `target[key]`, tracked for observable arrays (index / `length`) and missing keys of observable objects. */
export function getProperty(target: unknown, key: PropertyKey): unknown {
	if (target instanceof ObservableArray) {
		if (key === "length") {
			observeArray(target);
			return target.length;
		}
		return isIndexKey(key) ? target.get(index(key)) : target[key as never];
	}
	if (isObservableObjectLike(target)) return get(target, key);
	return (target as AnyRecord)[key];
}

/** `target[key] = value`, observed for observable arrays and objects (adding new keys). */
export function setProperty<V>(target: unknown, key: PropertyKey, value: V): V {
	if (target instanceof ObservableArray) {
		if (key === "length") target.setLength(Number(value));
		else if (isIndexKey(key)) target.set(index(key), value);
		else (target as unknown as AnyRecord)[key] = value;
		return value;
	}
	if (isObservableObjectLike(target)) {
		set(target, key, value);
		return value;
	}
	(target as AnyRecord)[key] = value;
	return value;
}

/** `++target[key]` / `target[key]--` (`delta` ±1; `prefix` returns the new value). */
export function updateProperty(
	target: unknown,
	key: PropertyKey,
	delta: 1 | -1,
	prefix: boolean,
): unknown {
	const previous = getProperty(target, key) as number | bigint;
	const next =
		typeof previous === "bigint"
			? previous + BigInt(delta)
			: Number(previous) + delta;
	setProperty(target, key, next);
	return prefix ? next : typeof previous === "bigint" ? previous : +previous;
}

/** `delete target[key]`, observed for observable arrays and objects. */
export function deleteProperty(target: unknown, key: PropertyKey): boolean {
	if (target instanceof ObservableArray && isIndexKey(key)) {
		return target.deleteIndex(index(key));
	}
	if (isObservableObjectLike(target)) {
		remove(target, key);
		return true;
	}
	return delete (target as AnyRecord)[key];
}

/** `key in target`, tracked for observable objects (including keys added later) and arrays. */
export function hasProperty(target: unknown, key: PropertyKey): boolean {
	if (target instanceof ObservableArray) {
		observeArray(target);
		return key in target;
	}
	if (isObservableObjectLike(target)) return has(target, key) || key in target;
	return key in (target as object);
}

/** `Object.keys(target)`, tracked for observable objects (keys added / removed) and arrays. */
export function keysOf(target: unknown): string[] {
	if (target instanceof ProxyLike) {
		return (target as ProxyLike<AnyRecord>).keys();
	}
	if (target instanceof ObservableArray) {
		observeArray(target);
	} else if (typeof target === "object" && target !== null) {
		administrationOf(target)?.keys(); // tracks the keys
	}
	return Object.keys(target as object);
}

/** `Object.values(target)`, tracked like {@link keysOf}. */
export function valuesOf(target: unknown): unknown[] {
	return keysOf(target).map((key) => getProperty(target, key));
}

/** `Object.entries(target)`, tracked like {@link keysOf}. */
export function entriesOf(target: unknown): Array<[string, unknown]> {
	return keysOf(target).map((key) => [key, getProperty(target, key)]);
}
