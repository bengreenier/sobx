import type { ReactNode } from "react";
import { useObserverInternal } from "./use-observer.js";

export interface IObserverProps {
	children?(): ReactNode;
	render?(): ReactNode;
}

/**
 * Renders `children()` (or `render()`) as an observer: only this part re-renders when what it
 * reads changes. `<Observer>{() => <span>{store.count}</span>}</Observer>`.
 */
export function Observer({ children, render }: IObserverProps): ReactNode {
	if (children && render) {
		console.error(
			"[sobx-react] Observer: Do not use children and render in the same time in `Observer`",
		);
	}
	const component = children || render;
	return useObserverInternal(
		() => (typeof component === "function" ? component() : null),
		"Observer",
	);
}
Observer.displayName = "Observer";
