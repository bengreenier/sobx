import { Component, PureComponent, version } from "react";
import { patch } from "./utils.js";

type Disposer = () => void;

const protoStoreKey = Symbol("sobxDisposeOnUnmountProto");
const instStoreKey = Symbol("sobxDisposeOnUnmountInst");

type Store = Array<PropertyKey | Disposer>;
type Target = Component & {
	[protoStoreKey]?: Store;
	[instStoreKey]?: Store;
	[key: PropertyKey]: unknown;
};

let warned = false;

function runDisposersOnWillUnmount(this: Target): void {
	for (const keyOrFn of [
		...(this[protoStoreKey] ?? []),
		...(this[instStoreKey] ?? []),
	]) {
		const value = typeof keyOrFn === "function" ? keyOrFn : this[keyOrFn];
		if (value == null) continue;
		if (Array.isArray(value)) for (const fn of value) (fn as Disposer)();
		else (value as Disposer)();
	}
}

function isComponentSubclass(target: object): boolean {
	const bases: unknown[] = [Component, PureComponent];
	const c = Object.getPrototypeOf(target).constructor;
	const c2 = Object.getPrototypeOf(target.constructor);
	// react-hot-loader adds a level of prototypes.
	const c3 = Object.getPrototypeOf(Object.getPrototypeOf(target))?.constructor;
	return bases.includes(c) || bases.includes(c2) || bases.includes(c3);
}

/**
 * @deprecated As in mobx-react: not compatible with React 18 and later (StrictMode re-mounts
 * components without re-running their constructor). Dispose in `componentWillUnmount`, or
 * use function components and `useEffect`.
 *
 * Calls a disposer (or each of an array of disposers) when the class component unmounts. As
 * a decorator on a property (`@disposeOnUnmount disposer = reaction(...)`), or called with the
 * component and the disposer(s): `disposeOnUnmount(this, reaction(...))`.
 */
export function disposeOnUnmount(
	target: Component,
	propertyKey: PropertyKey,
): void;
export function disposeOnUnmount<TF extends Disposer | Disposer[]>(
	target: Component,
	fn: TF,
): TF;
export function disposeOnUnmount(
	target: Component,
	keyOrFn: PropertyKey | Disposer | Disposer[],
): PropertyKey | Disposer | Disposer[] | undefined {
	if (Array.isArray(keyOrFn)) {
		return keyOrFn.map((fn) => disposeOnUnmount(target, fn));
	}
	if (!warned) {
		warned = true;
		if (Number.parseInt(version, 10) >= 18) {
			console.error(
				"[sobx-react] disposeOnUnmount is not compatible with React 18 and higher. Don't use it.",
			);
		} else {
			console.warn(
				"[sobx-react] disposeOnUnmount is deprecated. It won't work correctly with React 18 and higher.",
			);
		}
	}
	if (!isComponentSubclass(target)) {
		throw new Error(
			"[sobx-react] disposeOnUnmount only supports direct subclasses of React.Component or React.PureComponent.",
		);
	}
	if (typeof keyOrFn !== "string" && typeof keyOrFn !== "function") {
		throw new Error(
			"[sobx-react] disposeOnUnmount only works if the parameter is either a property key or a function.",
		);
	}
	const t = target as Target;
	// A decorator's target is the prototype: property keys are stored there, functions on the
	// instance.
	const isDecorator = typeof keyOrFn === "string";
	const alreadyPatched = !!t[protoStoreKey] || !!t[instStoreKey];
	const storeKey = isDecorator ? protoStoreKey : instStoreKey;
	t[storeKey] ??= [];
	(t[storeKey] as Store).push(keyOrFn);
	if (!alreadyPatched) {
		patch(target, "componentWillUnmount", runDisposersOnWillUnmount);
	}
	return isDecorator ? undefined : keyOrFn;
}
