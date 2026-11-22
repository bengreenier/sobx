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
import { $mobx, DEV, globalState, hooks, proxyOf } from "./core.js";
import type { ObjectAdministration } from "./object.js";

type AnyRecord = Record<PropertyKey, unknown>;

const admOf = (target: AnyRecord) =>
	(target as unknown as { [$mobx]: ObjectAdministration })[$mobx];

/** `useProxies: "ifavailable"`: development builds check for what wouldn't work without. */
function needsProxies(what: string): never {
	throw new Error(
		`sobx: MobX is currently configured to be able to run in ES5 mode, but in ES5 MobX won't be able to ${what}`,
	);
}

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
		if (DEV && globalState.verifyProxies && !admOf(target).values.has(key)) {
			needsProxies(
				"add a new observable property through direct assignment. Use 'set' from 'sobx' instead.",
			);
		}
		// An interceptor refusing isn't an error.
		return admOf(target).set(key, value, true) ?? true;
	},
	deleteProperty(target, key) {
		if (DEV && globalState.verifyProxies) {
			needsProxies(
				"delete properties from an observable object. Use 'remove' from 'sobx' instead.",
			);
		}
		return admOf(target).delete(key, true) ?? true;
	},
	has(target, key) {
		if (DEV && globalState.verifyProxies && globalState.tracking !== null) {
			needsProxies(
				"detect new properties using the 'in' operator. Use 'has' from 'sobx' instead.",
			);
		}
		return admOf(target).has(key);
	},
	ownKeys(target) {
		if (DEV && globalState.verifyProxies && globalState.tracking !== null) {
			needsProxies(
				"iterate keys to detect added / removed properties. Use 'keys' from 'sobx' instead.",
			);
		}
		return admOf(target).ownKeys() as Array<string | symbol>;
	},
	defineProperty(target, key, descriptor) {
		if (DEV && globalState.verifyProxies) {
			needsProxies(
				"define property on an observable object. Use 'defineProperty' from 'sobx' instead.",
			);
		}
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
			const value = target[key as never];
			if (key === "length") return value;
			const adm = arrayAdministrationOf(target);
			return adm?.dehancer === undefined || !(key in target)
				? value
				: adm.dehancer(value);
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
