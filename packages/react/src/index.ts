export { disposeOnUnmount } from "./dispose-on-unmount.js";
export {
	clearTimers,
	observerFinalizationRegistry as _observerFinalizationRegistry,
} from "./finalization.js";
export {
	useAsObservableSource,
	useLocalObservable,
	useLocalStore,
} from "./hooks.js";
export {
	type IObserverOptions,
	type IReactComponent,
	observer,
} from "./observer.js";
export { type IObserverProps, Observer } from "./observer-component.js";
export { PropTypes, type Requireable, type Validator } from "./prop-types.js";
export {
	type IStoresToProps,
	type IValueMap,
	type IWrappedComponent,
	inject,
	MobXProviderContext,
	Provider,
	type ProviderProps,
} from "./provider.js";
export {
	enableStaticRendering,
	isUsingStaticRendering,
	useStaticRendering,
} from "./static-rendering.js";
export { useObserver } from "./use-observer.js";

/**
 * @deprecated React batches updates itself (React 18+); kept for compatibility, does nothing.
 */
export function observerBatching(_reactionScheduler?: unknown): void {}

/** @deprecated Always `true`. */
export function isObserverBatched(): boolean {
	return true;
}
