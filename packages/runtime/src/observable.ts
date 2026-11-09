/**
 * MobX-compatible observable objects and classes: `observable()`, `makeObservable()`,
 * `makeAutoObservable()`, the annotations (`observable.ref`, `computed.struct`,
 * `action.bound`, ...), and standard (2022.3) decorators.
 *
 * Observable properties become accessors backed by a {@link ProxyLike} (sobx never uses `Proxy`).
 * Keys added later go through the explicit API (`set`, `remove`, `has`, `keys`; see `api.ts`),
 * which the compiler emits for code it can see. Deep observables convert the values put into them
 * (plain objects, arrays, Maps and Sets). This is the general path; the sobx compiler turns local
 * object observables it can fully see into a plain `ProxyLike` instead.
 */

import { createFlow, type FlowPromise } from "./async.js";
import {
	type ArrayOptions,
	type BoxOptions,
	type CollectionOptions,
	createObservableArray,
	enhance,
	isPlainObject,
	type ObservableArray,
	ObservableBox,
	ObservableMap,
	ObservableSet,
} from "./collections.js";
import {
	type Computed,
	type ComputedOptions,
	createComputed,
} from "./computed.js";
import {
	convertingTo,
	deepEqual,
	endBatch,
	globalState,
	hooks,
	notifyOwners,
	observableValues,
	runAction,
	startBatch,
} from "./core.js";
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
	/**
	 * Convert values put into observable properties (plain objects, arrays, Maps, Sets) into
	 * observables. Default `true`; `false` makes inferred properties `observable.ref`.
	 */
	deep?: boolean;
	/** For debugging; not used. */
	name?: string;
	/** Accepted for MobX compatibility and ignored: sobx never uses `Proxy`. */
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
		observableValues.add(target);
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
	const wrapped = function (this: unknown, ...args: A): R {
		startBatch();
		globalState.allowStateChanges++;
		const outer = globalState.tracking;
		if (untrackedReads) globalState.tracking = null;
		try {
			return fn.apply(this, args);
		} finally {
			globalState.tracking = outer;
			globalState.allowStateChanges--;
			endBatch();
		}
	};
	actions.add(wrapped);
	return wrapped;
}

const actions = new WeakSet<object>();

/** Whether `fn` was created by `action()` / an action annotation. */
export function isAction(fn: unknown): boolean {
	return typeof fn === "function" && actions.has(fn);
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

function infer(
	descriptor: PropertyDescriptor,
	options: ObservableOptions,
): Annotation {
	const autoBind = !!options.autoBind;
	if (descriptor.get) return { kind: "computed" };
	if (isGenerator(descriptor.value)) return { kind: "flow", bound: autoBind };
	if (typeof descriptor.value === "function") {
		return { kind: "autoAction", bound: autoBind };
	}
	return {
		kind: "observable",
		modifier: options.deep === false ? "ref" : "deep",
	};
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
				enumerable: descriptor.enumerable,
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
				enumerable: descriptor.enumerable,
				configurable: true,
			});
			return;
		}
	}
}

/**
 * How an observable property converts values put into it, as in MobX: `deep` makes plain
 * objects, arrays, Maps and Sets observable (deeply); `shallow` makes them observable without
 * converting their contents; `ref` and `struct` store values as they are.
 */
function enhancerFor(annotation: Annotation): <V>(value: V) => V {
	if (annotation.modifier === "deep") return (value) => enhance(value, true);
	if (annotation.modifier === "shallow")
		return (value) => enhance(value, false);
	return (value) => value;
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
			value === true ? infer(descriptor, options) : annotationOf(value, key);
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
					? infer(descriptor, options)
					: annotationOf(value, key);
			apply(target, key, annotation, descriptor, options);
		}
	}
	return target;
}

function createObservableObject<T extends object>(
	value: T,
	overrides?: AnnotationsMap<T>,
	options: ObservableOptions = {},
): T {
	if (Array.isArray(value)) {
		return createObservableArray(value, {
			deep: options.deep,
		}) as unknown as T;
	}
	if (value instanceof Map) {
		return new ObservableMap(value, options) as unknown as T;
	}
	if (value instanceof Set) {
		return new ObservableSet(value, options) as unknown as T;
	}
	if (observableValues.has(value)) return value;
	if (!isPlainObject(value)) {
		throw new Error(
			"sobx: observable() supports plain objects, arrays, Maps and Sets.",
		);
	}
	// Accessors only: sobx never uses `Proxy` (the `proxy` option is accepted and ignored).
	const result = Object.create(Object.getPrototypeOf(value)) as T;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(
			value,
			key,
		) as PropertyDescriptor;
		// The copy is ours to make observable, even if the source is frozen (e.g. React props).
		descriptor.configurable = true;
		if ("value" in descriptor) descriptor.writable = true;
		Object.defineProperty(result, key, descriptor);
	}
	// Registered before its values are converted, so cyclic / shared values convert once.
	administration(result);
	return convertingTo(value, result, () =>
		makeAutoObservable(result, overrides, options),
	);
}

// A module side effect that deep conversion (arrays, Maps, ProxyLike...) depends on: keep this
// module free of `"sideEffects": false` (or move the registration) so bundlers don't drop it.
hooks.object = (value, deep) =>
	createObservableObject(value, undefined, { deep });

/** Whether `value` is an observable object (`observable({...})`, a class made observable, or a `ProxyLike`). */
export function isObservableObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	return value instanceof ProxyLike || Object.hasOwn(value, ADMINISTRATION);
}

/**
 * @internal The store behind an observable object's properties (accessor-based objects and
 * classes), or `undefined` if `value` isn't one.
 */
export function administrationOf(
	value: object,
): ProxyLike<AnyRecord> | undefined {
	return (value as { [ADMINISTRATION]?: ProxyLike<AnyRecord> })[ADMINISTRATION];
}

/**
 * @internal Add an observable property to an accessor-based observable object (`set()` for a
 * new key): deep, like the properties `observable()` infers. Notifies readers of the key, of the
 * object's keys, and the object's owners.
 */
export function addObservableProperty(
	target: object,
	key: PropertyKey,
	value: unknown,
): void {
	const adm = administration(target);
	const prepare = enhancerFor({ kind: "observable", modifier: "deep" });
	Object.defineProperty(target, key, {
		get: () => adm.get(key),
		set: (next) => {
			adm.set(key, prepare(next));
		},
		enumerable: true,
		configurable: true,
	});
	startBatch();
	try {
		adm.set(key, prepare(value));
		notifyOwners(target);
	} finally {
		endBatch();
	}
}

/** @internal Remove an observable property (`remove()`): notifies like {@link addObservableProperty}. */
export function removeObservableProperty(
	target: object,
	key: PropertyKey,
): void {
	const adm = administrationOf(target);
	startBatch();
	try {
		delete (target as AnyRecord)[key];
		if (adm) {
			adm.delete(key);
		}
		notifyOwners(target);
	} finally {
		endBatch();
	}
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
	<T>(value: T[], overrides?: null, options?: ArrayOptions): ObservableArray<T>;
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
	/** `observable.array(values?, options?)`: an observable array. */
	array<T>(
		values?: Iterable<T> | null,
		options?: ArrayOptions,
	): ObservableArray<T>;
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
observable.array = (values, options) =>
	createObservableArray(values ?? [], options);

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
	return runAction(fn);
}
