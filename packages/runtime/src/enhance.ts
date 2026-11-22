/** How deep observables convert the values put into them, as in MobX. */
import {
	converting,
	DEV,
	type Equals,
	hooks,
	type Named,
	observableValues,
	stringifyKey,
} from "./core.js";

/** What a value is put into, to name what it's converted to. */
export type Place = Named | string | undefined;

/** Converts values put into an observable (`key` of `place`). */
export type Enhancer = <T>(value: T, place?: Place, key?: unknown) => T;

/** Constructors filled in by `collections.ts` (which uses this module). */
export const collections = {
	array: (value: unknown[], _deep: boolean, _name?: string): unknown => value,
	map: (
		value: Map<unknown, unknown>,
		_deep: boolean,
		_name?: string,
	): unknown => value,
	set: (value: Set<unknown>, _deep: boolean, _name?: string): unknown => value,
};

/** How a collection (or box) converts and compares its values. */
export interface ValueOptions {
	/** Convert values (plain objects, arrays, Maps, Sets) into observables. Default `true`. */
	deep?: boolean;
	/** An `observable` annotation to treat values as (when `deep` isn't given). */
	defaultDecorator?: unknown;
}

/** What an `observable` annotation does to values (filled in by `observable.ts`). */
export const annotationValues = {
	of(_decorator: unknown): { enhancer: Enhancer; equals: Equals } {
		return { enhancer: deepEnhancer, equals: Object.is };
	},
};

const deepEnhancer: Enhancer = (value, place, key) =>
	enhance(value, true, place, key);
const identity: Enhancer = (value) => value;

/** How values are converted and compared, given these options. */
export function valueHandling(options: ValueOptions): {
	enhancer: Enhancer;
	equals: Equals;
} {
	if (options.deep === undefined && options.defaultDecorator !== undefined) {
		return annotationValues.of(options.defaultDecorator);
	}
	return {
		enhancer: options.deep === false ? identity : deepEnhancer,
		equals: Object.is,
	};
}

function placeName(place: Place, key: unknown): string | undefined {
	if (!DEV || place === undefined) return undefined;
	const name = typeof place === "string" ? place : place.name;
	return key === undefined ? name : `${name}.${stringifyKey(key)}`;
}

/** Whether `value` is an object literal (of any realm), or has no prototype. */
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
 * (functions become auto-actions / flows; other values are returned as they are). `deep`: whether
 * the new observable's own values are converted too (`false` for `observable.shallow`).
 */
export function enhance<T>(
	value: T,
	deep = true,
	place?: Place,
	key?: unknown,
): T {
	if (typeof value === "function") {
		return deep ? (hooks.fn(value, placeName(place, key)) as T) : value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (observableValues.has(value)) return value;
	const inProgress = converting.get(value);
	if (inProgress) return inProgress as T;
	if (Array.isArray(value)) {
		return collections.array(value, deep, placeName(place, key)) as T;
	}
	if (value instanceof Map) {
		return collections.map(value, deep, placeName(place, key)) as T;
	}
	if (value instanceof Set) {
		return collections.set(value, deep, placeName(place, key)) as T;
	}
	if (isPlainObject(value)) {
		return hooks.object(value, deep, placeName(place, key)) as T;
	}
	return value;
}
