import { Reaction } from "@sobx/runtime";
import { type Component, type ComponentClass, PureComponent } from "react";
import { observerFinalizationRegistry } from "./finalization.js";
import { DEV, isUsingStaticRendering } from "./static-rendering.js";
import { shallowEqual } from "./utils.js";

const administration = Symbol("sobxObserverAdministration");
const isObserverClass = Symbol("sobxIsObserver");

interface ClassAdministration {
	/** `null` when disposed (or not created yet). */
	reaction: Reaction | null;
	forceUpdate: (() => void) | null;
	mounted: boolean;
	/** The reaction was invalidated before `componentDidMount` (e.g. by a child's). */
	invalidatedBeforeMount: boolean;
}

type AnyComponent = Component<unknown, unknown> & {
	[administration]?: ClassAdministration;
};

// biome-ignore lint/suspicious/noExplicitAny: React component classes have arbitrary props
export type AnyComponentClass = ComponentClass<any, any> & {
	[isObserverClass]?: true;
};

function getAdministration(component: AnyComponent): ClassAdministration {
	component[administration] ??= {
		reaction: null,
		forceUpdate: null,
		mounted: false,
		invalidatedBeforeMount: false,
	};
	return component[administration];
}

function displayName(componentClass: ComponentClass): string {
	return componentClass.displayName || componentClass.name || "<component>";
}

function createReaction(adm: ClassAdministration): Reaction {
	return new Reaction(() => {
		if (!adm.mounted) {
			// Re-render on mount instead (componentDidMount runs after the children's, which may
			// change what this component read).
			adm.invalidatedBeforeMount = true;
			return;
		}
		try {
			adm.forceUpdate?.();
		} catch {
			adm.reaction?.dispose();
			adm.reaction = null;
		}
	});
}

function observerShouldComponentUpdate(
	this: Component,
	nextProps: unknown,
	nextState: unknown,
): boolean {
	if (isUsingStaticRendering()) {
		console.warn(
			"[sobx-react] It seems that a re-rendering of a React component is triggered while in static (server-side) mode. Please make sure components are rendered only once server-side.",
		);
	}
	if (this.state !== nextState) return true;
	return !shallowEqual(this.props, nextProps);
}

/**
 * Make a class component an observer: its `render` is tracked, and the component re-renders
 * (`forceUpdate`) when what it read changes. Like mobx-react, adds a shallow-comparing
 * `shouldComponentUpdate` (unless the class extends `PureComponent`).
 */
export function makeClassComponentObserver<C extends AnyComponentClass>(
	componentClass: C,
): C {
	const { prototype } = componentClass;
	if (componentClass[isObserverClass]) {
		throw new Error(
			`The provided component class (${displayName(componentClass)}) has already been declared as an observer component.`,
		);
	}
	componentClass[isObserverClass] = true;

	if (prototype.componentWillReact) {
		throw new Error(
			"The componentWillReact life-cycle event is no longer supported",
		);
	}
	if (Object.getPrototypeOf(componentClass) !== PureComponent) {
		if (!prototype.shouldComponentUpdate) {
			prototype.shouldComponentUpdate = observerShouldComponentUpdate;
		} else if (
			prototype.shouldComponentUpdate !== observerShouldComponentUpdate
		) {
			throw new Error(
				"It is not allowed to use shouldComponentUpdate in observer based components.",
			);
		}
	}

	const originalRender = prototype.render;
	if (typeof originalRender !== "function") {
		throw new Error(
			`[sobx-react] class component (${displayName(componentClass)}) is missing \`render\` method.` +
				"\n`observer` requires `render` being a function defined on prototype." +
				"\n`render = () => {}` or `render = function() {}` is not supported.",
		);
	}

	prototype.render = function (this: AnyComponent) {
		Object.defineProperty(this, "render", {
			configurable: false,
			writable: false,
			value: isUsingStaticRendering()
				? originalRender
				: createReactiveRender(this, originalRender),
		});
		return this.render();
	};

	const originalDidMount = prototype.componentDidMount;
	prototype.componentDidMount = function (this: AnyComponent) {
		if (
			DEV &&
			this.componentDidMount !== Object.getPrototypeOf(this).componentDidMount
		) {
			throw new Error(
				`[sobx-react] \`observer(${displayName(componentClass)}).componentDidMount\` must be defined on prototype.` +
					"\n`componentDidMount = () => {}` or `componentDidMount = function() {}` is not supported.",
			);
		}
		const adm = getAdministration(this);
		adm.mounted = true;
		observerFinalizationRegistry.unregister(this);
		adm.forceUpdate = () => this.forceUpdate();
		if (!adm.reaction || adm.invalidatedBeforeMount) {
			// Re-mounted without rendering (StrictMode), so the subscriptions are gone; or
			// invalidated before mount. Render again (which creates the reaction if needed).
			adm.forceUpdate();
		}
		return originalDidMount?.apply(this);
	};

	const originalWillUnmount = prototype.componentWillUnmount;
	prototype.componentWillUnmount = function (this: AnyComponent) {
		try {
			return originalWillUnmount?.apply(this);
		} finally {
			if (!isUsingStaticRendering()) {
				const adm = getAdministration(this);
				adm.reaction?.dispose();
				adm.reaction = null;
				adm.forceUpdate = null;
				adm.mounted = false;
				adm.invalidatedBeforeMount = false;
			}
		}
	};

	return componentClass;
}

function createReactiveRender(
	component: AnyComponent,
	originalRender: () => unknown,
): () => unknown {
	const render = originalRender.bind(component);
	const adm = getAdministration(component);
	return () => {
		if (!adm.reaction) {
			adm.reaction = createReaction(adm);
			if (!adm.mounted) {
				// React may discard this instance without mounting it.
				observerFinalizationRegistry.register(component, adm, component);
			}
		}
		adm.invalidatedBeforeMount = false;
		// Errors propagate to React (error boundaries).
		return adm.reaction.track(render);
	};
}
