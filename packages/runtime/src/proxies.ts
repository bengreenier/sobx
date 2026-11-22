/**
 * `configure({ useProxies: "always" })`: observable objects and arrays behind a `Proxy`, for code
 * the compiler doesn't process. Existing keys still go through the observable's accessors (and
 * array methods run on the array itself); the traps handle what only a `Proxy` can observe in
 * plain JavaScript, through the same helpers compiled code uses.
 */
import {
	deleteProperty,
	getProperty,
	hasProperty,
	keysOf,
	setProperty,
} from "./api.js";
import { isIndexKey, type ObservableArray } from "./collections.js";
import { hooks } from "./core.js";

type AnyRecord = Record<PropertyKey, unknown>;

const objectHandler: ProxyHandler<AnyRecord> = {
	get(target, key, receiver) {
		if (typeof key === "symbol" || key in target) {
			return Reflect.get(target, key, receiver);
		}
		return getProperty(target, key); // tracked: the key may be added later
	},
	set(target, key, value) {
		if (typeof key === "symbol" || Object.hasOwn(target, key)) {
			return Reflect.set(target, key, value, target);
		}
		setProperty(target, key, value); // a new observable property
		return true;
	},
	deleteProperty(target, key) {
		if (typeof key === "symbol" || !Object.hasOwn(target, key)) {
			return Reflect.deleteProperty(target, key);
		}
		return deleteProperty(target, key);
	},
	has(target, key) {
		return typeof key === "symbol"
			? Reflect.has(target, key)
			: hasProperty(target, key);
	},
	ownKeys(target) {
		keysOf(target); // tracks the keys
		return Reflect.ownKeys(target);
	},
};

function arrayHandler(): ProxyHandler<ObservableArray<unknown>> {
	// Methods run on the array itself (they notify once), and return the proxy for `this`.
	const methods = new Map<unknown, unknown>();
	let proxy: unknown;
	return {
		get(target, key, receiver) {
			proxy = receiver;
			if (key === "length" || (typeof key === "string" && isIndexKey(key))) {
				return getProperty(target, key);
			}
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function" || key === "constructor") return value;
			let method = methods.get(value);
			if (!method) {
				method = function (this: unknown, ...args: unknown[]) {
					const self = this === proxy ? target : this;
					const result = (value as (...a: unknown[]) => unknown).apply(
						self,
						args,
					);
					return result === target ? proxy : result;
				};
				methods.set(value, method);
			}
			return method;
		},
		set(target, key, value) {
			if (key === "length" || (typeof key === "string" && isIndexKey(key))) {
				setProperty(target, key, value);
				return true;
			}
			return Reflect.set(target, key, value, target);
		},
		deleteProperty(target, key) {
			if (typeof key === "string" && isIndexKey(key)) {
				return deleteProperty(target, key);
			}
			return Reflect.deleteProperty(target, key);
		},
		has(target, key) {
			return typeof key === "symbol"
				? Reflect.has(target, key)
				: hasProperty(target, key);
		},
		ownKeys(target) {
			getProperty(target, "length"); // tracks the array
			return Reflect.ownKeys(target);
		},
	};
}

hooks.proxy = <T extends object>(raw: T, kind: "object" | "array"): T =>
	(kind === "array"
		? new Proxy(raw as unknown as ObservableArray<unknown>, arrayHandler())
		: new Proxy(raw as AnyRecord, objectHandler)) as unknown as T;
