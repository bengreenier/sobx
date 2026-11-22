import { Reaction } from "@sobx/runtime";
import { useDebugValue, useRef, useSyncExternalStore } from "react";
import { observerFinalizationRegistry } from "./finalization.js";
import { DEV, isUsingStaticRendering } from "./static-rendering.js";

/**
 * Per-component state. Must not reference the component's ref (not even through a closure):
 * the ref is what the finalization registry watches, to dispose the reaction of a component
 * that rendered but never mounted.
 */
interface ObserverAdministration {
	/** `null` when disposed (or not created yet). */
	reaction: Reaction | null;
	/** Set while subscribed (mounted). */
	onStoreChange: (() => void) | null;
	/** Changes every time the reaction is invalidated. */
	version: number;
	name: string;
	subscribe(onStoreChange: () => void): () => void;
	getSnapshot(): number;
}

function createReaction(adm: ObserverAdministration): void {
	adm.reaction = new Reaction(`observer${adm.name}`, () => {
		adm.version++;
		// Not set before the component mounts: useSyncExternalStore then sees the new version
		// when it subscribes, and re-renders.
		adm.onStoreChange?.();
	});
}

/**
 * Run `render` (a component's render), tracking the observables it reads, and re-render the
 * component when they change. The core of {@link observer}.
 */
export function useObserverInternal<T>(render: () => T, name: string): T {
	// Static rendering is set once for the whole app, so the hooks below are either always
	// called or never: their order doesn't change between renders.
	if (isUsingStaticRendering()) return render();

	// biome-ignore-start lint/correctness/useHookAtTopLevel: see above
	const admRef = useRef<ObserverAdministration | null>(null);
	if (admRef.current === null) {
		const adm: ObserverAdministration = {
			reaction: null,
			onStoreChange: null,
			version: 0,
			name,
			subscribe(onStoreChange) {
				// Mounted: the reaction lives until unsubscribed.
				observerFinalizationRegistry.unregister(adm);
				adm.onStoreChange = onStoreChange;
				if (!adm.reaction) {
					// The reaction (and so its subscriptions) was lost: React re-mounted the
					// component without rendering it (StrictMode), or the registry disposed it
					// before mount. Recreate it, and re-render to subscribe again.
					createReaction(adm);
					adm.version++;
				}
				return () => {
					adm.onStoreChange = null;
					adm.reaction?.dispose();
					adm.reaction = null;
				};
			},
			getSnapshot() {
				return adm.version;
			},
		};
		admRef.current = adm;
	}
	const adm = admRef.current;

	if (!adm.reaction) {
		createReaction(adm);
		// The render may never be committed (StrictMode, Suspense, concurrent rendering).
		observerFinalizationRegistry.register(admRef, adm, adm);
	}

	useDebugValue(adm, (a) => `observer${a.name ? ` ${a.name}` : ""}`);
	useSyncExternalStore(adm.subscribe, adm.getSnapshot, adm.getSnapshot);
	// biome-ignore-end lint/correctness/useHookAtTopLevel: see above

	return trackRender(adm.reaction as Reaction, render);
}

/**
 * Track `render` in `reaction`. Errors propagate to React (error boundaries), not to the
 * reaction's error handling; what was read so far stays tracked.
 */
export function trackRender<T>(reaction: Reaction, render: () => T): T {
	let result: T | undefined;
	let error: unknown;
	let failed = false;
	reaction.track(() => {
		try {
			result = render();
		} catch (e) {
			failed = true;
			error = e;
		}
	});
	if (failed) throw error;
	return result as T;
}

let warnedUseObserver = false;

/**
 * @deprecated Use `<Observer>{fn}</Observer>`, or wrap the component in `observer`.
 */
export function useObserver<T>(fn: () => T, baseComponentName = "observed"): T {
	if (DEV && !warnedUseObserver) {
		warnedUseObserver = true;
		console.warn(
			"[sobx-react] 'useObserver(fn)' is deprecated. Use `<Observer>{fn}</Observer>` instead, or wrap the entire component in `observer`.",
		);
	}
	return useObserverInternal(fn, baseComponentName);
}
