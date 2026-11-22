import {
	createContext,
	createElement,
	type FunctionComponent,
	forwardRef,
	type ReactNode,
	useContext,
	useRef,
} from "react";
import { type IReactComponent, observer } from "./observer.js";
import { DEV } from "./static-rendering.js";
import { copyStaticProperties, shallowEqual } from "./utils.js";

// biome-ignore lint/suspicious/noExplicitAny: stores of any type
export type IValueMap = Record<string, any>;

/** The stores provided by the nearest {@link Provider}s. */
export const MobXProviderContext = createContext<IValueMap>({});

export interface ProviderProps extends IValueMap {
	children: ReactNode;
}

/**
 * Provide stores to the components below it (read with {@link inject} or
 * `useContext(MobXProviderContext)`). The set of stores must not change.
 */
export function Provider(props: ProviderProps): ReactNode {
	const { children, ...stores } = props;
	const parent = useContext(MobXProviderContext);
	const ref = useRef({ ...parent, ...stores });
	const value = ref.current;
	if (DEV && !shallowEqual(value, { ...value, ...stores })) {
		throw new Error(
			"MobX Provider: The set of provided stores has changed. See: https://github.com/mobxjs/mobx-react#the-set-of-provided-stores-has-changed-error.",
		);
	}
	return createElement(MobXProviderContext.Provider, { value }, children);
}
Provider.displayName = "MobXProvider";

export type IStoresToProps<
	S extends IValueMap = object,
	P extends IValueMap = object,
	I extends IValueMap = object,
	C extends IValueMap = object,
> = (stores: S, nextProps: P, context?: C) => I;

export interface IWrappedComponent<P> {
	wrappedComponent: IReactComponent<P>;
}

function injectName(component: IReactComponent, names: string): string {
	const name =
		component.displayName ||
		(component as FunctionComponent).name ||
		component.constructor?.name ||
		"Component";
	return names ? `inject-with-${names}(${name})` : `inject(${name})`;
}

function createInjector(
	grabStores: (stores: IValueMap, props: IValueMap) => IValueMap | undefined,
	component: IReactComponent,
	names: string,
	makeReactive: boolean,
): IReactComponent {
	let Injector: IReactComponent = forwardRef<unknown, IValueMap>(
		(props, ref) => {
			const nextProps: IValueMap = { ...props };
			const context = useContext(MobXProviderContext);
			Object.assign(nextProps, grabStores(context || {}, nextProps) || {});
			if (ref) nextProps.ref = ref;
			return createElement(component, nextProps);
		},
	);
	if (makeReactive) Injector = observer(Injector);
	// biome-ignore lint/suspicious/noExplicitAny: marker properties
	const injector = Injector as any;
	injector.isMobxInjector = true;
	copyStaticProperties(component, Injector);
	injector.wrappedComponent = component;
	injector.displayName = injectName(component, names);
	return Injector;
}

function grabStoresByName(names: string[]) {
	return (stores: IValueMap, nextProps: IValueMap): IValueMap => {
		for (const name of names) {
			if (name in nextProps) continue; // props win over stores
			if (!(name in stores)) {
				throw new Error(
					`MobX injector: Store '${name}' is not available! Make sure it is provided by some Provider`,
				);
			}
			nextProps[name] = stores[name];
		}
		return nextProps;
	};
}

/**
 * Inject stores from the nearest {@link Provider}s as props: `inject("store")(Component)`, or
 * with a function mapping the stores (and props) to props, in which case the injector is
 * an observer: `inject((stores) => ({ count: stores.counter.count }))(Component)`.
 */
export function inject(
	...stores: string[]
): <T extends IReactComponent>(
	target: T,
) => T & (T extends IReactComponent<infer P> ? IWrappedComponent<P> : never);
export function inject<
	S extends IValueMap = object,
	P extends IValueMap = object,
	I extends IValueMap = object,
	C extends IValueMap = object,
>(
	fn: IStoresToProps<S, P, I, C>,
): <T extends IReactComponent>(target: T) => T & IWrappedComponent<P>;
export function inject(...args: unknown[]) {
	if (typeof args[0] === "function") {
		const grab = args[0] as IStoresToProps;
		return (component: IReactComponent) =>
			createInjector(grab, component, grab.name, true);
	}
	const names = args as string[];
	return (component: IReactComponent) =>
		createInjector(grabStoresByName(names), component, names.join("-"), false);
}
