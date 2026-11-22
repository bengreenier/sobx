/**
 * Observable objects and arrays are behind a `Proxy`, as in MobX, so that any code (compiled or
 * not) observes everything on them. Observable properties are read straight from the object's
 * administration, and array methods run on the array itself; the traps do the rest. Traps get the
 * observable itself as `target`, and the runtime only works on that, so a trap only ever runs for
 * user code.
 */
import {
	type ArrayAdministration,
	arrayAdministrationOf,
	isIndexKey,
	type ObservableArray,
	observeRawArray,
} from "./collections.js";
import { $mobx, globalState, hooks, proxyOf } from "./core.js";
import type { ObjectAdministration } from "./object.js";

type AnyRecord = Record<PropertyKey, unknown>;

const admOf = (target: AnyRecord) =>
	(target as unknown as { [$mobx]: ObjectAdministration })[$mobx];

const objectHandler: ProxyHandler<AnyRecord> = {
	get(target, key, receiver) {
		const adm = admOf(target);
		const observable = adm.values.get(key);
		if (observable !== undefined) return observable.get();
		// Tracked if the key doesn't exist: it may be added later.
		if (globalState.tracking !== null && !(key in target)) adm.has(key);
		return Reflect.get(target, key, receiver);
	},
	set(target, key, value, receiver) {
		// Inherited from an object whose prototype is the observable: not ours.
		if (receiver !== proxyOf(target) && !Object.hasOwn(target, key)) {
			return Reflect.set(target, key, value, receiver);
		}
		// An interceptor refusing isn't an error.
		return admOf(target).set(key, value, true) ?? true;
	},
	deleteProperty(target, key) {
		return admOf(target).delete(key, true) ?? true;
	},
	has(target, key) {
		return admOf(target).has(key);
	},
	ownKeys(target) {
		return admOf(target).ownKeys() as Array<string | symbol>;
	},
	defineProperty(target, key, descriptor) {
		return admOf(target).defineProperty(key, descriptor, true) ?? true;
	},
	preventExtensions() {
		throw new Error(
			"sobx: Dynamic observable objects cannot be frozen. If you're passing observables to 3rd party component/function that calls Object.freeze, pass copy instead: toJS(observable)",
		);
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
			const adm = arrayAdministrationOf(target) as ArrayAdministration;
			if (key === "length") adm.setLength(value);
			else adm.set(Number(key), value);
			return true;
		}
		return Reflect.set(target, key, value, target);
	},
	deleteProperty(target, key) {
		return isArrayKey(key)
			? target.deleteIndex(Number(key))
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
	preventExtensions() {
		throw new Error(
			"sobx: Observable arrays cannot be frozen. If you're passing observables to 3rd party component/function that calls Object.freeze, pass copy instead: toJS(observable)",
		);
	},
};

hooks.proxy = <T extends object>(raw: T, kind: "object" | "array"): T =>
	(kind === "array"
		? new Proxy(raw as unknown as ObservableArray<unknown>, arrayHandler)
		: new Proxy(raw as AnyRecord, objectHandler)) as unknown as T;
