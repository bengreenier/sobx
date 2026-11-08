/**
 * MobX-compatible observable objects and classes: `observable()`, `makeObservable()`,
 * `makeAutoObservable()`, the annotations (`observable.ref`, `computed.struct`,
 * `action.bound`, ...), and standard (2022.3) decorators.
 *
 * Observable properties become accessors backed by a {@link ProxyLike}, so they are tracked
 * by computeds and reactions. This is the general (slower) path; the sobx compiler turns
 * local object observables it can fully see into a plain `ProxyLike` instead.
 */

import { createFlow, type FlowPromise } from "./async.js";
import {
	type BoxOptions,
	type CollectionOptions,
	enhance,
	ObservableBox,
	ObservableMap,
	ObservableSet,
} from "./collections.js";
import {
	type Computed,
	type ComputedOptions,
	createComputed,
} from "./computed.js";
import { deepEqual, endBatch, globalState, startBatch } from "./core.js";
import { ProxyLike } from "./proxy-like.js";

type AnyRecord = Record<PropertyKey, unknown>;

/** An effective annotation, as attached to the annotation functions below. */
export interface Annotation {
	kind: "observable" | "computed" | "action" | "autoAction" | "flow";
	/** `observable.ref` / `.shallow` / `.struct` / `.deep`, `computed.struct`. */
	modifier?: "deep" | "ref" | "shallow" | "struct";
	/** `action.bound`, or `autoBind`. */
	bound?: boolean;
}

export interface ObservableOptions {
	/** Bind inferred actions to the object. */
	autoBind?: boolean;
	/** Accepted for compatibility. Observable properties are shallow. */
	deep?: boolean;
	/** For debugging; not used. */
	name?: string;
	/** Accepted for compatibility; objects are never wrapped in a `Proxy`. */
	proxy?: boolean;
}

/** An annotation value in a `makeObservable` / `makeAutoObservable` / `observable` map. */
export type AnnotationValue =
	| boolean
	// biome-ignore lint/suspicious/noExplicitAny: annotation functions have varied signatures
	| ((...args: any[]) => unknown);
// biome-ignore lint/correctness/noUnusedVariables: kept for MobX-compatible signatures
export type AnnotationsMap<T> = { [key: string]: AnnotationValue | undefined };

/** Standard decorator context, as much of it as is used here. */
interface DecoratorContext {
	kind: string;
	name: string | symbol;
	static?: boolean;
	addInitializer(initializer: (this: unknown) => void): void;
}

const ANNOTATION = Symbol("sobx.annotation");
const ADMINISTRATION = Symbol("sobx.administration");
const COMPUTEDS = Symbol("sobx.computeds");

function isDecoratorContext(value: unknown): value is DecoratorContext {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as DecoratorContext).kind === "string" &&
		typeof (value as DecoratorContext).addInitializer === "function"
	);
}

/** The per-object store behind observable properties. */
function administration(target: object): ProxyLike<AnyRecord> {
	let adm = (target as { [ADMINISTRATION]?: ProxyLike<AnyRecord> })[
		ADMINISTRATION
	];
	if (!adm) {
		// Values are enhanced per annotation, not by the store.
		adm = new ProxyLike<AnyRecord>({}, { deep: false });
		Object.defineProperty(target, ADMINISTRATION, { value: adm });
	}
	return adm;
}

function computedOf<T>(
	target: object,
	key: PropertyKey,
	getter: () => T,
	options: ComputedOptions<T>,
): Computed<T> {
	let map = (target as { [COMPUTEDS]?: Map<PropertyKey, Computed<unknown>> })[
		COMPUTEDS
	];
	if (!map) {
		map = new Map();
		Object.defineProperty(target, COMPUTEDS, { value: map });
	}
	let computed = map.get(key) as Computed<T> | undefined;
	if (!computed) {
		computed = createComputed(() => getter.call(target), options);
		map.set(key, computed as Computed<unknown>);
	}
	return computed;
}

/** Wrap `fn` so that it runs batched and (for actions, not auto-actions) untracked. */
export function createAction<A extends unknown[], R>(
	fn: (...args: A) => R,
	untrackedReads = true,
): (...args: A) => R {
	return function (this: unknown, ...args: A): R {
		startBatch();
		const outer = globalState.tracking;
		if (untrackedReads) globalState.tracking = null;
		try {
			return fn.apply(this, args);
		} finally {
			globalState.tracking = outer;
			endBatch();
		}
	};
}

function describe(target: object, key: PropertyKey): PropertyDescriptor | null {
	for (
		let o: object | null = target;
		o && o !== Object.prototype;
		o = Object.getPrototypeOf(o)
	) {
		const descriptor = Object.getOwnPropertyDescriptor(o, key);
		if (descriptor) return descriptor;
	}
	return null;
}

function isGenerator(fn: unknown): boolean {
	const name = (fn as { constructor?: { name?: string } })?.constructor?.name;
	return name === "GeneratorFunction" || name === "AsyncGeneratorFunction";
}

function infer(descriptor: PropertyDescriptor, autoBind: boolean): Annotation {
	if (descriptor.get) return { kind: "computed" };
	if (isGenerator(descriptor.value)) return { kind: "flow", bound: autoBind };
	if (typeof descriptor.value === "function") {
		return { kind: "autoAction", bound: autoBind };
	}
	return { kind: "observable", modifier: "deep" };
}

function annotationOf(value: AnnotationValue, key: PropertyKey): Annotation {
	const annotation =
		typeof value === "function"
			? (value as { [ANNOTATION]?: Annotation })[ANNOTATION]
			: undefined;
	if (!annotation) {
		throw new Error(`sobx: invalid annotation for "${String(key)}".`);
	}
	return annotation;
}

function apply(
	target: object,
	key: PropertyKey,
	annotation: Annotation,
	descriptor: PropertyDescriptor,
	options: ObservableOptions,
): void {
	const name = String(key);
	switch (annotation.kind) {
		case "observable": {
			if (descriptor.get || descriptor.set) {
				throw new Error(
					`sobx: "${name}" is an accessor and can't be observable.`,
				);
			}
			const adm = administration(target);
			const prepare = enhancerFor(annotation);
			adm.init(key, prepare(descriptor.value));
			if (annotation.modifier === "struct") adm.setEquals(key, deepEqual);
			Object.defineProperty(target, key, {
				get: () => adm.get(key),
				set: (value) => {
					adm.set(key, prepare(value));
				},
				enumerable: true,
				configurable: true,
			});
			return;
		}
		case "computed": {
			const getter = descriptor.get;
			if (!getter)
				throw new Error(`sobx: computed "${name}" must be a getter.`);
			const computed = computedOf(target, key, getter, {
				equals: annotation.modifier === "struct" ? deepEqual : undefined,
			});
			const setter = descriptor.set && createAction(descriptor.set);
			Object.defineProperty(target, key, {
				get: () => computed.get(),
				set: setter
					? (value) => {
							setter.call(target, value);
						}
					: undefined,
				enumerable: false,
				configurable: true,
			});
			return;
		}
		case "action":
		case "autoAction": {
			const fn = descriptor.value;
			if (typeof fn !== "function") {
				throw new Error(`sobx: action "${name}" must be a function.`);
			}
			const bound = annotation.bound || options.autoBind;
			const wrapped = createAction(
				bound ? fn.bind(target) : fn,
				annotation.kind === "action",
			);
			Object.defineProperty(target, key, {
				value: wrapped,
				writable: true,
				enumerable: false,
				configurable: true,
			});
			return;
		}
		case "flow": {
			const fn = descriptor.value;
			if (!isGenerator(fn)) {
				throw new Error(`sobx: flow "${name}" must be a generator function.`);
			}
			const bound = annotation.bound || options.autoBind;
			Object.defineProperty(target, key, {
				value: createFlow(bound ? fn.bind(target) : fn),
				writable: true,
				enumerable: false,
				configurable: true,
			});
			return;
		}
	}
}

/** Observable values (deep / shallow) make a plain Map / Set observable, as in MobX. */
function enhancerFor(annotation: Annotation): <V>(value: V) => V {
	return annotation.modifier === "deep" || annotation.modifier === "shallow"
		? enhance
		: (value) => value;
}

/**
 * Make the given members of `target` observable, like MobX's `makeObservable`. Call it in
 * the constructor. Without annotations (classes using decorators), it does nothing.
 */
export function makeObservable<T extends object>(
	target: T,
	annotations?: AnnotationsMap<T>,
	options: ObservableOptions = {},
): T {
	if (!annotations) return target;
	for (const key of Reflect.ownKeys(annotations)) {
		const value = (annotations as Record<PropertyKey, AnnotationValue>)[key];
		if (value === false || value === undefined) continue;
		const descriptor = describe(target, key);
		if (!descriptor) {
			throw new Error(
				`sobx: makeObservable: "${String(key)}" is not a member of the target.`,
			);
		}
		const annotation =
			value === true
				? infer(descriptor, !!options.autoBind)
				: annotationOf(value, key);
		apply(target, key, annotation, descriptor, options);
	}
	return target;
}

/**
 * Make every member of `target` observable, inferring annotations (getters are computed,
 * functions are auto-actions, everything else is observable), like MobX's
 * `makeAutoObservable`. `overrides` sets or excludes (`false`) specific members.
 */
export function makeAutoObservable<T extends object>(
	target: T,
	overrides: AnnotationsMap<T> = {},
	options: ObservableOptions = {},
): T {
	const seen = new Set<PropertyKey>();
	const overridden = overrides as Record<PropertyKey, AnnotationValue>;
	for (const key of Reflect.ownKeys(overrides)) {
		if (!describe(target, key)) {
			throw new Error(
				`sobx: makeAutoObservable: "${String(key)}" is not a member of the target.`,
			);
		}
	}
	for (
		let o: object | null = target;
		o && o !== Object.prototype;
		o = Object.getPrototypeOf(o)
	) {
		for (const key of Reflect.ownKeys(o)) {
			if (key === "constructor" || typeof key === "symbol" || seen.has(key)) {
				continue;
			}
			seen.add(key);
			const value = overridden[key];
			if (value === false) continue;
			const descriptor = describe(target, key) as PropertyDescriptor;
			const annotation =
				value === undefined || value === true
					? infer(descriptor, !!options.autoBind)
					: annotationOf(value, key);
			apply(target, key, annotation, descriptor, options);
		}
	}
	return target;
}

function createObservableObject<T extends object>(
	value: T,
	overrides?: AnnotationsMap<T>,
	options?: ObservableOptions,
): T {
	if (Array.isArray(value)) {
		throw new Error(
			"sobx: observable arrays are not supported yet; use a plain object, a Map or a Set.",
		);
	}
	if (value instanceof Map) {
		return new ObservableMap(value, options) as unknown as T;
	}
	if (value instanceof Set) {
		return new ObservableSet(value, options) as unknown as T;
	}
	const proto =
		typeof value === "object" && value !== null
			? Object.getPrototypeOf(value)
			: undefined;
	if (proto !== Object.prototype && proto !== null) {
		throw new Error("sobx: observable() only supports plain objects.");
	}
	const result = Object.create(proto) as T;
	for (const key of Reflect.ownKeys(value)) {
		Object.defineProperty(
			result,
			key,
			Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor,
		);
	}
	return makeAutoObservable(result, overrides, options);
}

/** Attach `annotation` to `fn`, so it can be used in annotation maps. */
function annotate<F extends object>(fn: F, annotation: Annotation): F {
	Object.defineProperty(fn, ANNOTATION, { value: annotation });
	return fn;
}

function observableDecorator(annotation: Annotation) {
	return (
		_value: unknown,
		context: DecoratorContext,
	): { get(): unknown; set(v: unknown): void; init(v: unknown): unknown } => {
		if (context.kind !== "accessor") {
			throw new Error(
				`sobx: @observable on "${String(context.name)}" needs an \`accessor\` field.`,
			);
		}
		const key = context.name;
		const prepare = enhancerFor(annotation);
		return {
			get(this: object) {
				return administration(this).get(key);
			},
			set(this: object, value: unknown) {
				administration(this).set(key, prepare(value));
			},
			init(this: object, value: unknown) {
				const adm = administration(this);
				adm.init(key, prepare(value));
				if (annotation.modifier === "struct") adm.setEquals(key, deepEqual);
				return value;
			},
		};
	};
}

function computedDecorator(struct: boolean) {
	return (getter: () => unknown, context: DecoratorContext) => {
		if (context.kind !== "getter") {
			throw new Error(
				`sobx: @computed on "${String(context.name)}" must decorate a getter.`,
			);
		}
		const key = context.name;
		const equals = struct ? deepEqual : undefined;
		return function (this: object) {
			return computedOf(this, key, getter, { equals }).get();
		};
	};
}

function actionDecorator(bound: boolean) {
	return (
		// biome-ignore lint/suspicious/noExplicitAny: decorated methods have any signature
		fn: (...args: any[]) => unknown,
		context: DecoratorContext,
	) => {
		if (context.kind !== "method") {
			throw new Error(
				`sobx: @action on "${String(context.name)}" must decorate a method.`,
			);
		}
		const wrapped = createAction(fn);
		if (bound) {
			const key = context.name;
			context.addInitializer(function (this: unknown) {
				const self = this as AnyRecord;
				self[key] = (self[key] as typeof wrapped).bind(self);
			});
		}
		return wrapped;
	};
}

function decoratorOnly(
	annotation: Annotation,
	label: string,
): AccessorAnnotation {
	const decorator = observableDecorator(annotation);
	return annotate((value: unknown, context?: unknown) => {
		if (!isDecoratorContext(context)) {
			throw new Error(
				`sobx: ${label} can only be used as an annotation or decorator.`,
			);
		}
		return decorator(value, context);
	}, annotation) as unknown as AccessorAnnotation;
}

/** `@observable accessor x` (also usable in annotation maps). */
export type AccessorAnnotation = <This, V>(
	value: ClassAccessorDecoratorTarget<This, V>,
	context: ClassAccessorDecoratorContext<This, V>,
) => ClassAccessorDecoratorResult<This, V>;

/** `@computed get x()` (also usable in annotation maps). */
export type GetterAnnotation = <This, V>(
	getter: (this: This) => V,
	context: ClassGetterDecoratorContext<This, V>,
) => (this: This) => V;

/** `@action m()` (also usable in annotation maps). */
export type MethodAnnotation = <This, A extends unknown[], R>(
	fn: (this: This, ...args: A) => R,
	context: ClassMethodDecoratorContext<This, (this: This, ...args: A) => R>,
) => (this: This, ...args: A) => R;

export interface ObservableFn extends AccessorAnnotation {
	<K, V>(
		value: Map<K, V>,
		overrides?: null,
		options?: CollectionOptions,
	): ObservableMap<K, V>;
	<T>(
		value: Set<T>,
		overrides?: null,
		options?: CollectionOptions,
	): ObservableSet<T>;
	<T extends object>(
		value: T,
		overrides?: AnnotationsMap<T>,
		options?: ObservableOptions,
	): T;
	/** `observable.box(value, options?)`: a single observable value. */
	box<T>(value: T, options?: BoxOptions<T>): ObservableBox<T>;
	/** `observable.map(entries?, options?)`: an observable Map. */
	map<K, V>(
		entries?: Iterable<readonly [K, V]> | Record<string, V> | null,
		options?: CollectionOptions,
	): ObservableMap<K, V>;
	/** `observable.set(values?, options?)`: an observable Set. */
	set<T>(
		values?: Iterable<T> | null,
		options?: CollectionOptions,
	): ObservableSet<T>;
	ref: AccessorAnnotation;
	shallow: AccessorAnnotation;
	struct: AccessorAnnotation;
	deep: AccessorAnnotation;
}

const deepDecorator = observableDecorator({
	kind: "observable",
	modifier: "deep",
});

/**
 * `observable(object, overrides?, options?)`: an observable copy of a plain object. Also an
 * annotation (`{ x: observable }`) and an accessor decorator (`@observable accessor x`).
 */
export const observable = annotate(
	(value: object, second?: unknown, options?: ObservableOptions) => {
		if (isDecoratorContext(second)) return deepDecorator(value, second);
		return createObservableObject(
			value,
			second as AnnotationsMap<object> | undefined,
			options,
		);
	},
	{ kind: "observable", modifier: "deep" },
) as ObservableFn;
observable.ref = decoratorOnly(
	{ kind: "observable", modifier: "ref" },
	"observable.ref",
);
observable.shallow = decoratorOnly(
	{ kind: "observable", modifier: "shallow" },
	"observable.shallow",
);
observable.struct = decoratorOnly(
	{ kind: "observable", modifier: "struct" },
	"observable.struct",
);
observable.deep = decoratorOnly(
	{ kind: "observable", modifier: "deep" },
	"observable.deep",
);
observable.box = (value, options) => new ObservableBox(value, options);
observable.map = <K, V>(
	entries?: Iterable<readonly [K, V]> | Record<string, V> | null,
	options?: CollectionOptions,
) =>
	new ObservableMap<K, V>(
		entries && !(Symbol.iterator in entries)
			? (Object.entries(entries) as unknown as Array<[K, V]>)
			: (entries as Iterable<readonly [K, V]> | null | undefined),
		options,
	);
observable.set = (values, options) => new ObservableSet(values, options);

export interface ComputedFn extends GetterAnnotation {
	<T>(fn: () => T, options?: ComputedOptions<T>): Computed<T>;
	struct: GetterAnnotation;
}

const plainComputedDecorator = computedDecorator(false);
const structComputedDecorator = computedDecorator(true);

/**
 * `computed(fn, options?)`: a computed value (read with `.get()`). Also an annotation and a
 * getter decorator (`@computed get x()`).
 */
export const computed = annotate(
	(fn: () => unknown, second?: unknown) => {
		if (isDecoratorContext(second)) return plainComputedDecorator(fn, second);
		return createComputed(fn, second as ComputedOptions<unknown> | undefined);
	},
	{ kind: "computed" },
) as ComputedFn;
computed.struct = annotate(
	(getter: () => unknown, context?: unknown) => {
		if (!isDecoratorContext(context)) {
			throw new Error(
				"sobx: computed.struct can only be used as an annotation or decorator.",
			);
		}
		return structComputedDecorator(getter, context);
	},
	{ kind: "computed", modifier: "struct" },
) as unknown as GetterAnnotation;

export interface ActionFn extends MethodAnnotation {
	// biome-ignore lint/suspicious/noExplicitAny: wraps any function
	<F extends (...args: any[]) => any>(fn: F): F;
	// biome-ignore lint/suspicious/noExplicitAny: wraps any function
	<F extends (...args: any[]) => any>(name: string, fn: F): F;
	bound: MethodAnnotation;
}

const plainActionDecorator = actionDecorator(false);
const boundActionDecorator = actionDecorator(true);

/**
 * `action(fn)` / `action(name, fn)`: wrap a function so it runs batched and untracked. Also an
 * annotation and a method decorator (`@action m()`, `@action.bound m()`).
 */
export const action = annotate(
	// biome-ignore lint/suspicious/noExplicitAny: wraps any function
	(first: string | ((...args: any[]) => unknown), second?: unknown) => {
		if (typeof first === "function" && isDecoratorContext(second)) {
			return plainActionDecorator(first, second);
		}
		const fn = typeof first === "string" ? second : first;
		if (typeof fn !== "function") {
			throw new Error("sobx: action() expects a function.");
		}
		// biome-ignore lint/suspicious/noExplicitAny: wraps any function
		return createAction(fn as (...args: any[]) => unknown);
	},
	{ kind: "action" },
) as ActionFn;
action.bound = annotate(
	// biome-ignore lint/suspicious/noExplicitAny: decorated methods have any signature
	(fn: (...args: any[]) => unknown, context?: unknown) => {
		if (!isDecoratorContext(context)) {
			throw new Error(
				"sobx: action.bound can only be used as an annotation or decorator.",
			);
		}
		return boundActionDecorator(fn, context);
	},
	{ kind: "action", bound: true },
) as unknown as MethodAnnotation;

// biome-ignore lint/suspicious/noExplicitAny: flows wrap generators of any signature
type GeneratorFn = (...args: any[]) => Generator<unknown, unknown, unknown>;

function flowDecorator(bound: boolean) {
	return (fn: GeneratorFn, context: DecoratorContext) => {
		if (context.kind !== "method") {
			throw new Error(
				`sobx: @flow on "${String(context.name)}" must decorate a generator method.`,
			);
		}
		const wrapped = createFlow(fn);
		if (bound) {
			const key = context.name;
			context.addInitializer(function (this: unknown) {
				const self = this as AnyRecord;
				self[key] = (self[key] as typeof wrapped).bind(self);
			});
		}
		return wrapped;
	};
}

/** `@flow *m()` (also usable in annotation maps). */
export type FlowAnnotation = <This, A extends unknown[], R>(
	fn: (this: This, ...args: A) => Generator<unknown, R, unknown>,
	context: ClassMethodDecoratorContext<
		This,
		(this: This, ...args: A) => Generator<unknown, R, unknown>
	>,
) => (this: This, ...args: A) => FlowPromise<R>;

export interface FlowFn extends FlowAnnotation {
	<A extends unknown[], R>(
		generator: (...args: A) => Generator<unknown, R, unknown>,
	): (...args: A) => FlowPromise<R>;
	bound: FlowAnnotation;
}

const plainFlowDecorator = flowDecorator(false);
const boundFlowDecorator = flowDecorator(true);

/**
 * `flow(function* () {...})`: an async action written as a generator; each step between
 * `yield`s runs as an action. Also an annotation and a method decorator (`@flow *m()`,
 * `@flow.bound *m()`).
 */
export const flow = annotate(
	(generator: GeneratorFn, context?: unknown) =>
		isDecoratorContext(context)
			? plainFlowDecorator(generator, context)
			: createFlow(generator),
	{ kind: "flow" },
) as unknown as FlowFn;
flow.bound = annotate(
	(generator: GeneratorFn, context?: unknown) => {
		if (!isDecoratorContext(context)) {
			throw new Error(
				"sobx: flow.bound can only be used as an annotation or decorator.",
			);
		}
		return boundFlowDecorator(generator, context);
	},
	{ kind: "flow", bound: true },
) as unknown as FlowAnnotation;

/** Run `fn` now as an action (batched, untracked) and return its result. */
export function runInAction<T>(fn: () => T): T {
	startBatch();
	const outer = globalState.tracking;
	globalState.tracking = null;
	try {
		return fn();
	} finally {
		globalState.tracking = outer;
		endBatch();
	}
}
