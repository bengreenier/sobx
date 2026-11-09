import {
	type AnnotationsMap,
	observable,
	runInAction,
	set,
} from "@sobx/runtime";
import { useState } from "react";
import { DEV } from "./static-rendering.js";

/**
 * An observable created once, for the life of the component:
 * `useLocalObservable(() => ({ count: 0, inc() { this.count++ } }))`. Functions become
 * (auto-bound) actions and getters computeds, as with `observable(...)`.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches mobx-react-lite's signature
export function useLocalObservable<TStore extends Record<string, any>>(
	initializer: () => TStore,
	annotations?: AnnotationsMap<TStore>,
): TStore {
	return useState(() =>
		observable(initializer(), annotations, { autoBind: true }),
	)[0];
}

const warned = new Set<string>();
function deprecated(message: string): void {
	if (!DEV || warned.has(message)) return;
	warned.add(message);
	console.warn(message);
}

/**
 * @deprecated Store the values in an observable (e.g. with `useLocalObservable`) and sync
 * them with `useEffect` when needed.
 */
export function useAsObservableSource<TSource extends object>(
	current: TSource,
): TSource {
	deprecated(
		"[sobx-react] 'useAsObservableSource' is deprecated, please store the values directly in an observable, for example by using 'useLocalObservable', and sync future updates using 'useEffect' when needed.",
	);
	const source = useState(() => observable(current, {}, { deep: false }))[0];
	// `set` (not Object.assign): sobx doesn't use Proxy, so new keys must be added explicitly.
	runInAction(() => set(source, current as Record<string, unknown>));
	return source;
}

/** @deprecated Use {@link useLocalObservable}. */
// biome-ignore lint/suspicious/noExplicitAny: matches mobx-react-lite's signature
export function useLocalStore<TStore extends Record<string, any>>(
	initializer: () => TStore,
): TStore;
/** @deprecated Use {@link useLocalObservable}. */
export function useLocalStore<
	// biome-ignore lint/suspicious/noExplicitAny: matches mobx-react-lite's signature
	TStore extends Record<string, any>,
	TSource extends object,
>(initializer: (source: TSource) => TStore, current: TSource): TStore;
export function useLocalStore<
	// biome-ignore lint/suspicious/noExplicitAny: matches mobx-react-lite's signature
	TStore extends Record<string, any>,
	TSource extends object,
>(initializer: (source?: TSource) => TStore, current?: TSource): TStore {
	deprecated(
		"[sobx-react] 'useLocalStore' is deprecated, use 'useLocalObservable' instead.",
	);
	// biome-ignore lint/correctness/useHookAtTopLevel: as in mobx-react-lite, whether `current` is passed must not change
	const source = current && useAsObservableSource(current);
	return useState(() =>
		observable(initializer(source), undefined, { autoBind: true }),
	)[0];
}
