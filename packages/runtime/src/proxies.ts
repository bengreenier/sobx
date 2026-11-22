/**
 * Observable objects and arrays are behind a `Proxy`, as in MobX, so that any code (compiled or
 * not) observes everything on them. Existing keys go through the observable's accessors, and
 * array methods run on the array itself; the traps handle what accessors can't observe. Traps
 * get the observable itself as `target`, and the runtime only works on that, so a trap only ever
 * runs for user code.
 */
import { deleteProperty } from "./api.js";
import {
	isIndexKey,
	type ObservableArray,
	observeRawArray,
} from "./collections.js";
import { endBatch, globalState, hooks, proxyOf, startBatch } from "./core.js";
import { addObservableProperty, administrationOf } from "./observable.js";
import type { ProxyLike } from "./proxy-like.js";

type AnyRecord = Record<PropertyKey, unknown>;

const admOf = (target: object) =>
	administrationOf(target) as ProxyLike<AnyRecord>;

const objectHandler: ProxyHandler<AnyRecord> = {
	get(target, key, receiver) {
		// Observable properties: straight from the store (as their accessors do).
		const adm = admOf(target);
		if (typeof key === "string" && adm.owns(key)) return adm.read(key);
		const value = Reflect.get(target, key, receiver);
		if (value !== undefined || typeof key === "symbol" || key in target) {
			return value;
		}
		// Tracked: the key may be added later.
		return globalState.tracking === null ? undefined : adm.get(key);
	},
	set(target, key, value, receiver) {
		if (typeof key === "symbol" || Object.hasOwn(target, key)) {
			target[key] = value; // the accessor
			return true;
		}
		// Inherited from an object whose prototype is the observable: not ours.
		if (receiver !== proxyOf(target)) {
			return Reflect.set(target, key, value, receiver);
		}
		addObservableProperty(target, key, value);
		return true;
	},
	deleteProperty(target, key) {
		if (typeof key === "symbol" || !Object.hasOwn(target, key)) {
			return Reflect.deleteProperty(target, key);
		}
		return deleteProperty(target, key);
	},
	has(target, key) {
		if (globalState.tracking !== null && typeof key !== "symbol") {
			admOf(target).has(key);
		}
		return key in target;
	},
	ownKeys(target) {
		admOf(target).observeKeys();
		return Reflect.ownKeys(target);
	},
	defineProperty(target, key, descriptor) {
		if (typeof key === "symbol") {
			return Reflect.defineProperty(target, key, descriptor);
		}
		// Replaces an observable property with a plain one, as in MobX.
		const adm = admOf(target);
		startBatch();
		try {
			if (adm.owns(key)) adm.delete(key);
			const defined = Reflect.defineProperty(target, key, descriptor);
			adm.keyRedefined(key);
			return defined;
		} finally {
			endBatch();
		}
	},
};

const isArrayKey = (key: PropertyKey) =>
	typeof key === "string" && (key === "length" || isIndexKey(key));

const arrayHandler: ProxyHandler<ObservableArray<unknown>> = {
	get(target, key, receiver) {
		if (isArrayKey(key)) {
			observeRawArray(target);
			return target[key as never];
		}
		return Reflect.get(target, key, receiver);
	},
	set(target, key, value) {
		if (isArrayKey(key)) {
			if (key === "length") target.setLength(Number(value));
			else target.set(Number(key), value);
			return true;
		}
		return Reflect.set(target, key, value, target);
	},
	deleteProperty(target, key) {
		return isArrayKey(key)
			? deleteProperty(target, key)
			: Reflect.deleteProperty(target, key);
	},
	has(target, key) {
		observeRawArray(target);
		return key in target;
	},
	ownKeys(target) {
		observeRawArray(target);
		return Reflect.ownKeys(target);
	},
	defineProperty(target, key, descriptor) {
		return isArrayKey(key)
			? target.defineKey(key, descriptor)
			: Reflect.defineProperty(target, key, descriptor);
	},
};

hooks.proxy = <T extends object>(raw: T, kind: "object" | "array"): T =>
	(kind === "array"
		? new Proxy(raw as unknown as ObservableArray<unknown>, arrayHandler)
		: new Proxy(raw as AnyRecord, objectHandler)) as unknown as T;
