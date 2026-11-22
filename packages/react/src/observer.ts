import {
	Component,
	type ComponentClass,
	type ForwardRefExoticComponent,
	type ForwardRefRenderFunction,
	type FunctionComponent,
	forwardRef,
	type MemoExoticComponent,
	memo,
	type PropsWithoutRef,
	PureComponent,
	type Ref,
	type RefAttributes,
} from "react";
import {
	type AnyComponentClass,
	makeClassComponentObserver,
} from "./observer-class.js";
import { DEV, isUsingStaticRendering } from "./static-rendering.js";
import { useObserverInternal } from "./use-observer.js";
import { copyStaticProperties } from "./utils.js";

const ForwardRefSymbol = Symbol.for("react.forward_ref");
const MemoSymbol = Symbol.for("react.memo");

/** Any component `observer` accepts. */
// biome-ignore lint/suspicious/noExplicitAny: components with any props
export type IReactComponent<P = any> =
	| ComponentClass<P>
	| FunctionComponent<P>
	| ForwardRefExoticComponent<P>;

/**
 * @deprecated Observer options will be removed; pass a `React.forwardRef` component to
 * `observer` instead.
 */
export interface IObserverOptions {
	/** @deprecated Use `observer(React.forwardRef(fn))`. */
	readonly forwardRef?: boolean;
}

let warnedOptions = false;

function isClassComponent(component: unknown): component is AnyComponentClass {
	return (
		typeof component === "function" &&
		(Object.prototype.isPrototypeOf.call(Component, component) ||
			Object.prototype.isPrototypeOf.call(PureComponent, component))
	);
}

/**
 * Make a component react to the observables it reads while rendering: it re-renders when
 * they change, and only then (function components are also wrapped in `React.memo`).
 * Works with function components, `React.forwardRef` components and class components, and as
 * a standard class decorator (`@observer class C extends Component {}`).
 */
export function observer<P extends object, TRef = object>(
	baseComponent: ForwardRefRenderFunction<TRef, P>,
	options: IObserverOptions & { forwardRef: true },
): MemoExoticComponent<
	ForwardRefExoticComponent<PropsWithoutRef<P> & RefAttributes<TRef>>
>;
export function observer<P extends object, TRef = object>(
	baseComponent: ForwardRefExoticComponent<
		PropsWithoutRef<P> & RefAttributes<TRef>
	>,
): MemoExoticComponent<
	ForwardRefExoticComponent<PropsWithoutRef<P> & RefAttributes<TRef>>
>;
export function observer<T extends IReactComponent>(
	component: T,
	context: ClassDecoratorContext,
): void;
export function observer<T extends IReactComponent>(
	component: T,
	options?: IObserverOptions,
): T;
export function observer(
	// biome-ignore lint/suspicious/noExplicitAny: any component
	baseComponent: any,
	optionsOrContext?: IObserverOptions | ClassDecoratorContext,
	// biome-ignore lint/suspicious/noExplicitAny: any component
): any {
	const context =
		optionsOrContext && "kind" in optionsOrContext
			? optionsOrContext
			: undefined;
	if (context && context.kind !== "class") {
		throw new Error("The @observer decorator can be used on classes only");
	}
	if (baseComponent.isMobxInjector === true) {
		console.warn(
			"[sobx-react] You are trying to use `observer` on a component that already has `inject`. Please apply `observer` before applying `inject`",
		);
	}
	if (isClassComponent(baseComponent)) {
		return makeClassComponentObserver(baseComponent);
	}
	return observerFunction(
		baseComponent,
		context ? undefined : (optionsOrContext as IObserverOptions | undefined),
	);
}

function observerFunction(
	// biome-ignore lint/suspicious/noExplicitAny: any function / forwardRef component
	baseComponent: any,
	options: IObserverOptions | undefined,
) {
	if (DEV && options && !warnedOptions) {
		warnedOptions = true;
		console.warn(
			"[sobx-react] `observer(fn, { forwardRef: true })` is deprecated, use `observer(React.forwardRef(fn))`",
		);
	}
	if (baseComponent.$$typeof === MemoSymbol) {
		throw new Error(
			"[sobx-react] You are trying to use `observer` on a function component wrapped in either another `observer` or `React.memo`. The observer already applies 'React.memo' for you.",
		);
	}
	if (isUsingStaticRendering()) return baseComponent;

	let useForwardRef = options?.forwardRef ?? false;
	let render = baseComponent;
	const name: string = baseComponent.displayName || baseComponent.name;

	if (baseComponent.$$typeof === ForwardRefSymbol) {
		useForwardRef = true;
		render = baseComponent.render;
		if (typeof render !== "function") {
			throw new Error(
				"[sobx-react] `render` property of ForwardRef was not a function",
			);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: wrapped below
	let component: any = (props: unknown, ref: Ref<unknown>) =>
		useObserverInternal(() => render(props, ref), name);
	component.displayName = baseComponent.displayName;
	Object.defineProperty(component, "name", {
		value: baseComponent.name,
		writable: true,
		configurable: true,
	});
	if (baseComponent.contextTypes) {
		component.contextTypes = baseComponent.contextTypes;
	}
	if (useForwardRef) component = forwardRef(component);
	// Props that change deeply are expected to be observables, which are tracked anyway.
	component = memo(component);
	copyStaticProperties(baseComponent, component);
	return component;
}
