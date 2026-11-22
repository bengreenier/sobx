/**
 * MobX-compatible observable objects and classes: `observable()`, `makeObservable()`,
 * `makeAutoObservable()`, `extendObservable()`, the annotations (`observable.ref`,
 * `computed.struct`, `action.bound`, ...), and decorators (standard and legacy).
 *
 * Observable properties become accessors of the object's administration (`object.ts`).
 * `observable()` objects are behind a `Proxy` (`proxies.ts`), which observes everything else; class
 * instances aren't, as in MobX. This is the general path; the sobx compiler turns local object
 * observables it can fully see into a plain `ProxyLike` instead.
 */

import { createAction, isAction } from "./action.js";
import { createFlow, type FlowPromise, isFlow } from "./async.js";
import {
	type ArrayOptions,
	type BoxOptions,
	type CollectionOptions,
	createObservableArray,
	type MapEntries,
	type ObservableArray,
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
	DEV,
	debugName,
	deepEqual,
	type Equals,
	endBatch,
	globalState,
	hooks,
	maybeProxy,
	observableValues,
	startBatch,
} from "./core.js";
import {
	annotationValues,
	type Enhancer,
	enhance,
	isPlainObject,
	valueHandling,
} from "./enhance.js";
import {
	type Annotation,
	administer,
	administrationOf,
	type ObjectAdministration,
	storedAnnotations,
} from "./object.js";
import { ProxyLike } from "./proxy-like.js";
import { isSpying, spyReport } from "./spy.js";
import { ObservableValue } from "./value.js";

export { isAction, runInAction } from "./action.js";
export type { Annotation } from "./object.js";
export { administrationOf } from "./object.js";

// biome-ignore lint/suspicious/noExplicitAny: wraps functions of any signature
type AnyFn = (...args: any[]) => any;

export interface ObservableOptions {
	/** Bind inferred actions to the object. */
	autoBind?: boolean;
	/**
	 * Convert values put into observable properties (plain objects, arrays, Maps, Sets) into
	 * observables. Default `true`; `false` makes inferred properties `observable.ref`.
	 */
	deep?: boolean;
	/** The annotation inferred properties get. */
	defaultDecorator?: AnnotationValue;
	/** For debugging. */
	name?: string;
	/** `false`: don't put this object behind a `Proxy`. */
	proxy?: boolean;
}

/** An annotation value in a `makeObservable` / `makeAutoObservable` / `observable` map. */
export type AnnotationValue = boolean | AnyFn;
// biome-ignore lint/correctness/noUnusedVariables: kept for MobX-compatible signatures
export type AnnotationsMap<T, AdditionalFields extends PropertyKey = never> = {
	[key: string]: AnnotationValue | undefined;
};

/** Standard decorator context, as much of it as is used here. */
interface DecoratorContext {
	kind: string;
	name: string | symbol;
	static?: boolean;
	addInitializer(initializer: (this: unknown) => void): void;
}

const ANNOTATION = Symbol("sobx.annotation");

function isDecoratorContext(value: unknown): value is DecoratorContext {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as DecoratorContext).kind === "string"
	);
}

const isKey = (value: unknown): value is PropertyKey =>
	typeof value === "string" ||
	typeof value === "symbol" ||
	typeof value === "number";

/** Run `fn` while creating observables: untracked, batched, and allowed to change state. */
function initialize<T>(fn: () => T): T {
	const tracking = globalState.tracking;
	const allow = globalState.allowStateChanges;
	globalState.tracking = null;
	globalState.allowStateChanges = true;
	startBatch();
	try {
		return fn();
	} finally {
		endBatch();
		globalState.allowStateChanges = allow;
		globalState.tracking = tracking;
	}
}

// -- annotations ----------------------------------------------------------------------------

function invalid(
	adm: ObjectAdministration,
	type: string,
	key: PropertyKey,
	why: string,
): never {
	throw new Error(
		`sobx: Cannot apply '${type}' to '${adm.memberName(key)}': '${type}' ${why}.`,
	);
}

const deep: Enhancer = (value, place, key) => enhance(value, true, place, key);
const shallow: Enhancer = (value, place, key) =>
	enhance(value, false, place, key);
const ref: Enhancer = (value) => value;

interface ObservableAnnotation extends Annotation {
	readonly enhancer: Enhancer;
	readonly equals: Equals;
}

function observableAnnotation(
	type: string,
	enhancer: Enhancer,
	equals: Equals = Object.is,
): ObservableAnnotation {
	return {
		type,
		enhancer,
		equals,
		make(adm, key, descriptor) {
			return this.extend(adm, key, descriptor, false) === null
				? "cancel"
				: "break";
		},
		extend(adm, key, descriptor, trap) {
			if (!("value" in descriptor)) {
				invalid(adm, type, key, "cannot be used on getter/setter properties");
			}
			return adm.defineObservable(
				key,
				descriptor.value,
				enhancer,
				equals,
				trap,
			);
		},
	};
}

const observableDeep = observableAnnotation("observable", deep);
const observableRef = observableAnnotation("observable.ref", ref);
const observableShallow = observableAnnotation("observable.shallow", shallow);
const observableStruct = observableAnnotation(
	"observable.struct",
	ref,
	deepEqual,
);

interface ComputedAnnotation extends Annotation {
	readonly options: ComputedOptions<unknown>;
}

function computedAnnotation(
	type: string,
	options: ComputedOptions<unknown> = {},
): ComputedAnnotation {
	return {
		type,
		options,
		make(adm, key, descriptor) {
			return this.extend(adm, key, descriptor, false) === null
				? "cancel"
				: "break";
		},
		extend(adm, key, descriptor, trap) {
			const getter = descriptor.get;
			if (!getter) {
				invalid(
					adm,
					type,
					key,
					"can only be used on getter(+setter) properties",
				);
			}
			return adm.defineComputed(
				key,
				getter,
				descriptor.set ? { ...options, set: descriptor.set } : options,
				trap,
			);
		},
	};
}

const computedPlain = computedAnnotation("computed");
const computedStruct = computedAnnotation("computed.struct", {
	equals: deepEqual,
});

interface ActionOptions {
	name?: string;
	bound?: boolean;
	auto?: boolean;
}

interface ActionAnnotation extends Annotation {
	readonly options: ActionOptions;
}

function actionDescriptor(
	adm: ObjectAdministration,
	annotation: ActionAnnotation,
	key: PropertyKey,
	descriptor: PropertyDescriptor,
	safe = globalState.safeDescriptors,
): PropertyDescriptor {
	const { type, options } = annotation;
	let fn = descriptor.value;
	if (typeof fn !== "function") {
		invalid(
			adm,
			type,
			key,
			"can only be used on properties with a function value",
		);
	}
	if (options.bound) fn = fn.bind(adm.object);
	return {
		value: createAction(
			options.name ?? String(key),
			fn,
			options.auto,
			options.bound ? adm.object : undefined,
		),
		configurable: safe ? adm.isPlain : true,
		enumerable: false,
		writable: !safe,
	};
}

function actionAnnotation(
	type: string,
	options: ActionOptions = {},
): ActionAnnotation {
	return {
		type,
		options,
		make(adm, key, descriptor, source) {
			if (options.bound) {
				return this.extend(adm, key, descriptor, false) === null
					? "cancel"
					: "break";
			}
			if (source === adm.target) {
				return this.extend(adm, key, descriptor, false) === null
					? "cancel"
					: "continue";
			}
			// Annotated already, by another instance's constructor.
			if (isAction(descriptor.value)) return "break";
			// On the prototype, so that `super.method()` is an action too.
			Object.defineProperty(
				source,
				key,
				actionDescriptor(adm, this as ActionAnnotation, key, descriptor, false),
			);
			return "continue";
		},
		extend(adm, key, descriptor, trap) {
			return adm.defineProperty(
				key,
				actionDescriptor(adm, this as ActionAnnotation, key, descriptor),
				trap,
			);
		},
	};
}

const actionPlain = actionAnnotation("action");
const actionBound = actionAnnotation("action.bound", { bound: true });
const autoActionPlain = actionAnnotation("autoAction", { auto: true });
const autoActionBound = actionAnnotation("autoAction.bound", {
	auto: true,
	bound: true,
});

interface FlowAnnotationInternal extends Annotation {
	readonly bound: boolean;
}

function flowDescriptor(
	adm: ObjectAdministration,
	annotation: Annotation,
	key: PropertyKey,
	descriptor: PropertyDescriptor,
	bound: boolean,
	safe = globalState.safeDescriptors,
): PropertyDescriptor {
	let fn = descriptor.value;
	if (typeof fn !== "function") {
		invalid(
			adm,
			annotation.type,
			key,
			"can only be used on properties with a generator function value",
		);
	}
	if (!isFlow(fn)) fn = createFlow(fn);
	if (bound) {
		fn = fn.bind(adm.object);
		fn.isMobXFlow = true;
	}
	return {
		value: fn,
		configurable: safe ? adm.isPlain : true,
		enumerable: false,
		writable: !safe,
	};
}

function flowAnnotation(type: string, bound: boolean): FlowAnnotationInternal {
	return {
		type,
		bound,
		make(adm, key, descriptor, source) {
			if (source === adm.target) {
				return this.extend(adm, key, descriptor, false) === null
					? "cancel"
					: "continue";
			}
			const own = adm.target as Record<PropertyKey, unknown>;
			if (bound && (!Object.hasOwn(own, key) || !isFlow(own[key]))) {
				if (this.extend(adm, key, descriptor, false) === null) return "cancel";
			}
			if (isFlow(descriptor.value)) return "break";
			Object.defineProperty(
				source,
				key,
				flowDescriptor(adm, this, key, descriptor, false, false),
			);
			return "continue";
		},
		extend(adm, key, descriptor, trap) {
			return adm.defineProperty(
				key,
				flowDescriptor(adm, this, key, descriptor, bound),
				trap,
			);
		},
	};
}

const flowPlain = flowAnnotation("flow", false);
const flowBound = flowAnnotation("flow.bound", true);

/** Inferred annotations: getters are computed, functions auto-actions, and so on. */
function autoAnnotation(options: ObservableOptions): Annotation {
	const { autoBind } = options;
	const observed = options.deep === false ? observableRef : observableDeep;
	const bind = (adm: ObjectAdministration, descriptor: PropertyDescriptor) =>
		typeof descriptor.value === "function" && autoBind
			? { ...descriptor, value: descriptor.value.bind(adm.object) }
			: descriptor;
	return {
		type: "true",
		make(adm, key, descriptor, source) {
			if (descriptor.get) {
				return computedPlain.make(adm, key, descriptor, source);
			}
			if (descriptor.set) {
				const set = isAction(descriptor.set)
					? descriptor.set
					: createAction(String(key), descriptor.set);
				if (source === adm.target) {
					return adm.defineProperty(key, {
						configurable: globalState.safeDescriptors ? adm.isPlain : true,
						set,
					}) === null
						? "cancel"
						: "continue";
				}
				Object.defineProperty(source, key, { configurable: true, set });
				return "continue";
			}
			if (source !== adm.target && typeof descriptor.value === "function") {
				const annotation = isGenerator(descriptor.value)
					? autoBind
						? flowBound
						: flowPlain
					: autoBind
						? autoActionBound
						: autoActionPlain;
				return annotation.make(adm, key, descriptor, source);
			}
			return observed.make(adm, key, bind(adm, descriptor), source);
		},
		extend(adm, key, descriptor, trap) {
			if (descriptor.get) {
				return computedPlain.extend(adm, key, descriptor, trap);
			}
			if (descriptor.set) {
				return adm.defineProperty(
					key,
					{
						configurable: globalState.safeDescriptors ? adm.isPlain : true,
						set: createAction(String(key), descriptor.set),
					},
					trap,
				);
			}
			return observed.extend(adm, key, bind(adm, descriptor), trap);
		},
	};
}

const autoDefault = autoAnnotation({});

const overrideAnnotation: Annotation = {
	type: "override",
	make(adm, key) {
		if (DEV && adm.isPlain) {
			invalid(adm, "override", key, "cannot be used on plain objects");
		}
		if (DEV && !adm.isApplied(key)) {
			throw new Error(
				`sobx: '${adm.memberName(key)}' is annotated with 'override', but no such annotated member was found on prototype.`,
			);
		}
		return "cancel";
	},
	extend() {
		throw new Error("sobx: 'override' can only be used with 'makeObservable'");
	},
};

function isGenerator(fn: unknown): boolean {
	const name = (fn as { constructor?: { name?: string } })?.constructor?.name;
	return name === "GeneratorFunction" || name === "AsyncGeneratorFunction";
}

function annotationOf(
	value: AnnotationValue,
	key: PropertyKey,
): Annotation | boolean {
	if (typeof value === "boolean") return value;
	const annotation = (value as { [ANNOTATION]?: Annotation } | undefined)?.[
		ANNOTATION
	];
	if (!annotation) {
		throw new Error(`sobx: invalid annotation for "${String(key)}".`);
	}
	return annotation;
}

annotationValues.of = (decorator) => {
	const annotation = annotationOf(
		decorator as AnnotationValue,
		"defaultDecorator",
	) as Partial<ObservableAnnotation>;
	return {
		enhancer: annotation.enhancer ?? deep,
		equals: annotation.equals ?? Object.is,
	};
};

// Functions put into deep observables are auto-actions (or flows), as in MobX.
hooks.fn = (fn, name) => {
	if (isAction(fn) || isFlow(fn) || typeof fn !== "function") return fn;
	// Classes can't be called without `new`.
	if (/^class\b/.test(Function.prototype.toString.call(fn))) return fn;
	return isGenerator(fn)
		? createFlow(fn as never)
		: createAction(name ?? fn.name, fn as AnyFn, true);
};

// -- making observables ---------------------------------------------------------------------

function defaultAnnotationOf(options: ObservableOptions): Annotation {
	const { defaultDecorator } = options;
	if (defaultDecorator !== undefined) {
		const annotation = annotationOf(defaultDecorator, "defaultDecorator");
		if (typeof annotation !== "boolean") return annotation;
	}
	return options.autoBind || options.deep === false
		? autoAnnotation(options)
		: autoDefault;
}

/** Annotations left by legacy decorators, copied to the instance (each is applied once). */
function collectStored(target: object): Record<PropertyKey, Annotation> {
	const stored = target as {
		[storedAnnotations]?: Record<PropertyKey, Annotation>;
	};
	if (!Object.hasOwn(target, storedAnnotations)) {
		Object.defineProperty(target, storedAnnotations, {
			value: { ...stored[storedAnnotations] },
			configurable: true,
			writable: true,
		});
	}
	return stored[storedAnnotations] as Record<PropertyKey, Annotation>;
}

/**
 * Make the given members of `target` observable, like MobX's `makeObservable`. Call it in the
 * constructor. Without annotations, the ones given by (legacy) decorators are used.
 */
export function makeObservable<
	T extends object,
	AdditionalKeys extends PropertyKey = never,
>(
	target: T,
	annotations?: AnnotationsMap<T, AdditionalKeys>,
	options: ObservableOptions = {},
): T {
	initialize(() => {
		const adm = administer(target, defaultAnnotationOf(options), options.name);
		if (annotations) {
			if (
				DEV &&
				(target as { [storedAnnotations]?: object })[storedAnnotations]
			) {
				throw new Error(
					"sobx: makeObservable second arg must be nullish when using decorators. Mixing @decorator syntax with annotations is not supported.",
				);
			}
			for (const key of Reflect.ownKeys(annotations)) {
				const value = (annotations as Record<PropertyKey, AnnotationValue>)[
					key
				];
				if (value === undefined) continue;
				adm.make(key, annotationOf(value, key));
			}
			return;
		}
		const stored = collectStored(target);
		for (const key of Reflect.ownKeys(stored)) {
			adm.make(key, stored[key] as Annotation);
		}
	});
	return target;
}

/**
 * Make every member of `target` observable, inferring annotations (getters are computed,
 * functions are auto-actions, everything else is observable), like MobX's
 * `makeAutoObservable`. `overrides` sets or excludes (`false`) specific members.
 */
export function makeAutoObservable<
	T extends object,
	AdditionalKeys extends PropertyKey = never,
>(
	target: T,
	overrides: AnnotationsMap<T, AdditionalKeys> = {},
	options: ObservableOptions = {},
): T {
	const prototype = Object.getPrototypeOf(target);
	if (DEV) {
		if (!isPlainObject(target) && !isPlainObject(prototype)) {
			throw new Error(
				"sobx: 'makeAutoObservable' can only be used for classes that don't have a superclass",
			);
		}
		if (administrationOf(target)) {
			throw new Error(
				"sobx: makeAutoObservable can only be used on objects not already made observable",
			);
		}
	}
	for (const key of Reflect.ownKeys(overrides)) {
		if (DEV && !(key in target)) {
			throw new Error(
				`sobx: makeAutoObservable: "${String(key)}" is not a member of the target.`,
			);
		}
	}
	if (isPlainObject(target)) {
		return extendObservable(target, target, overrides, options) as T;
	}
	initialize(() => {
		const adm = administer(target, defaultAnnotationOf(options), options.name);
		const keys = new Set([
			...Reflect.ownKeys(target),
			...Reflect.ownKeys(prototype),
		]);
		keys.delete("constructor");
		for (const key of keys) {
			if (typeof key === "symbol" && isInternalKey(target, key)) continue;
			const value = (overrides as Record<PropertyKey, AnnotationValue>)[key];
			adm.make(
				key,
				Object.hasOwn(overrides, key) && value !== undefined
					? annotationOf(value, key)
					: true,
			);
		}
	});
	return target;
}

/** The administration and stored annotations aren't members. */
function isInternalKey(target: object, key: symbol): boolean {
	return (
		key === storedAnnotations ||
		(target as Record<symbol, unknown>)[key] === administrationOf(target)
	);
}

/** Add observable members to `target` (which isn't put behind a `Proxy`). */
export function extendObservable<A extends object, B extends object>(
	target: A,
	properties: B,
	annotations?: AnnotationsMap<B>,
	options: ObservableOptions = {},
): A & B {
	if (DEV) {
		if (typeof target !== "object" || target === null) {
			throw new Error(
				"sobx: 'extendObservable' expects an object as first argument",
			);
		}
		if (target instanceof ObservableMap) {
			throw new Error(
				"sobx: 'extendObservable' should not be used on maps, use map.merge instead",
			);
		}
		if (!isPlainObject(properties)) {
			throw new Error(
				"sobx: 'extendObservable' only accepts plain objects as second argument",
			);
		}
		if (
			(observableValues.has(properties) && (properties as object) !== target) ||
			(annotations && observableValues.has(annotations))
		) {
			throw new Error(
				"sobx: Extending an object with another observable (object) is not supported",
			);
		}
	}
	// First, so as not to see what the administration adds.
	const descriptors = Object.getOwnPropertyDescriptors(properties) as Record<
		PropertyKey,
		PropertyDescriptor
	>;
	initialize(() => {
		const adm = administer(target, defaultAnnotationOf(options), options.name);
		extendAll(adm, descriptors, annotations);
	});
	return target as A & B;
}

function extendAll(
	adm: ObjectAdministration,
	descriptors: Record<PropertyKey, PropertyDescriptor>,
	annotations?: AnnotationsMap<unknown>,
): void {
	for (const key of Reflect.ownKeys(descriptors)) {
		const value = (annotations as Record<PropertyKey, AnnotationValue>)?.[key];
		adm.extend(
			key,
			descriptors[key] as PropertyDescriptor,
			annotations && Object.hasOwn(annotations, key) && value !== undefined
				? annotationOf(value, key)
				: true,
		);
	}
}

/** `observable.object(value)`: an observable copy of a plain object. */
function createObservableObject<T extends object>(
	value: T,
	annotations?: AnnotationsMap<T>,
	options: ObservableOptions = {},
): T {
	const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
		PropertyKey,
		PropertyDescriptor
	>;
	return initialize(() => {
		const target = {} as T;
		const adm = administer(target, defaultAnnotationOf(options), options.name);
		const object =
			options.proxy === false ? target : maybeProxy(target, "object");
		// Registered before its values are converted, so cyclic / shared values convert once.
		convertingTo(value, object, () => extendAll(adm, descriptors, annotations));
		return object;
	});
}

function createObservable(
	value: unknown,
	second?: unknown,
	options?: ObservableOptions,
): unknown {
	if (typeof value !== "object" || value === null) {
		return createBox(value, second as BoxOptions<unknown>);
	}
	if (observableValues.has(value)) return value;
	if (isPlainObject(value)) {
		return createObservableObject(
			value,
			second as AnnotationsMap<object>,
			options,
		);
	}
	// Collections take their options second, as in MobX (or third, like objects).
	const collection = (options ?? second ?? {}) as CollectionOptions;
	if (Array.isArray(value)) return createObservableArray(value, collection);
	const other: object = value;
	if (other instanceof Map) return new ObservableMap(other, collection);
	if (other instanceof Set) return new ObservableSet(other, collection);
	throw new Error(
		"sobx: observable() supports plain objects, arrays, Maps and Sets.",
	);
}

function createBox<T>(
	value: T,
	options: BoxOptions<T> = {},
): ObservableValue<T> {
	const name = options.name ?? debugName("ObservableValue");
	const { enhancer, equals } = valueHandling(options);
	const box = new ObservableValue(
		value,
		enhancer,
		(options.equals as Equals | undefined) ?? equals,
		name,
	);
	observableValues.add(box);
	if (isSpying()) {
		spyReport({
			type: "create",
			object: box,
			observableKind: "value",
			debugObjectName: name,
			newValue: `${box.current}`,
		});
	}
	return box;
}

// A module side effect that deep conversion (arrays, Maps, ProxyLike...) depends on: keep this
// module free of `"sideEffects": false` (or move the registration) so bundlers don't drop it.
hooks.object = (value, isDeep, name) =>
	createObservableObject(value, undefined, { deep: isDeep, name });

/** Whether `value` is an observable object (`observable({...})`, a class made observable, or a `ProxyLike`). */
export function isObservableObject(value: unknown): boolean {
	return value instanceof ProxyLike || administrationOf(value) !== undefined;
}

// -- decorators -----------------------------------------------------------------------------

/** Attach `annotation` to `fn`, so it can be used in annotation maps. */
function annotate<F extends object>(fn: F, annotation: Annotation): F {
	Object.defineProperty(fn, ANNOTATION, { value: annotation });
	return fn;
}

/** Legacy decorators leave their annotation on the prototype, for `makeObservable(this)`. */
function storeAnnotation(
	prototype: object,
	key: PropertyKey,
	annotation: Annotation,
): void {
	const holder = prototype as {
		[storedAnnotations]?: Record<PropertyKey, Annotation>;
	};
	if (!Object.hasOwn(prototype, storedAnnotations)) {
		Object.defineProperty(prototype, storedAnnotations, {
			value: { ...holder[storedAnnotations] },
			configurable: true,
			writable: true,
		});
	}
	const stored = holder[storedAnnotations] as Record<PropertyKey, Annotation>;
	const field = `${prototype.constructor?.name}.prototype.${String(key)}`;
	const isOverride = annotation.type === "override";
	if (DEV && isOverride && !Object.hasOwn(stored, key)) {
		throw new Error(
			`sobx: '${field}' is decorated with 'override', but no such decorated member was found on prototype.`,
		);
	}
	if (DEV && !isOverride && Object.hasOwn(stored, key)) {
		throw new Error(
			`sobx: Cannot apply '@${annotation.type}' to '${field}': The field is already decorated with '@${stored[key]?.type}'. Re-decorating fields is not allowed. Use '@override' decorator for methods overridden by subclass.`,
		);
	}
	if (!isOverride) stored[key] = annotation;
}

/** `this`'s administration, created for classes whose decorators need it. */
const instanceAdministration = (instance: object) =>
	administer(instance, autoDefault);

function kindError(context: DecoratorContext, what: string): never {
	throw new Error(
		`sobx: ${what} (got a ${context.kind}: "${String(context.name)}").`,
	);
}

function decorateObservable(
	annotation: ObservableAnnotation,
	context: DecoratorContext,
) {
	if (context.kind !== "accessor") {
		kindError(context, "@observable needs an `accessor` field");
	}
	const key = context.name;
	const create = (instance: object, value: unknown) => {
		const adm = instanceAdministration(instance);
		const observable = new ObservableValue(
			value,
			annotation.enhancer,
			annotation.equals,
			adm,
			key,
		);
		adm.values.set(key, observable);
		return adm;
	};
	return {
		get(this: object) {
			return administrationOf(this)?.read(key);
		},
		set(this: object, value: unknown) {
			const adm = administrationOf(this);
			if (adm?.values.has(key)) adm.write(key, value);
			else create(this, value);
		},
		init(this: object, value: unknown) {
			create(this, value);
			return value;
		},
	};
}

function decorateComputed(
	annotation: ComputedAnnotation,
	getter: () => unknown,
	context: DecoratorContext,
) {
	if (context.kind !== "getter") {
		kindError(context, "@computed must decorate a getter");
	}
	const key = context.name;
	// Per class: a subclass's getter may call `super`'s.
	const computeds = new WeakMap<object, Computed<unknown>>();
	return function (this: object) {
		let computed = computeds.get(this);
		if (!computed) {
			const adm = instanceAdministration(this);
			computed = adm.createComputed(key, getter, annotation.options);
			computeds.set(this, computed);
			if (!adm.values.has(key)) adm.values.set(key, computed);
		}
		return computed.get();
	};
}

function decorateAction(
	annotation: ActionAnnotation,
	fn: AnyFn,
	context: DecoratorContext,
) {
	const { options } = annotation;
	const key = context.name;
	const create = (f: AnyFn) =>
		isAction(f)
			? f
			: createAction(options.name ?? String(key), f, options.auto);
	if (context.kind === "field") {
		return function (this: unknown, initial: AnyFn) {
			const wrapped = create(initial);
			return options.bound ? wrapped.bind(this) : wrapped;
		};
	}
	if (context.kind !== "method") {
		kindError(context, "@action must decorate a method (or a field)");
	}
	const wrapped = create(fn);
	if (options.bound) {
		context.addInitializer(function (this: unknown) {
			const self = this as Record<PropertyKey, AnyFn>;
			self[key] = (self[key] as AnyFn).bind(self);
		});
	}
	return wrapped;
}

function decorateFlow(
	annotation: FlowAnnotationInternal,
	fn: AnyFn,
	context: DecoratorContext,
) {
	if (context.kind !== "method") {
		kindError(context, "@flow must decorate a generator method");
	}
	const wrapped = isFlow(fn) ? fn : createFlow(fn);
	if (annotation.bound) {
		const key = context.name;
		context.addInitializer(function (this: unknown) {
			const self = this as Record<PropertyKey, AnyFn>;
			self[key] = (self[key] as AnyFn).bind(self);
		});
	}
	return wrapped;
}

type Decorate = (value: never, context: DecoratorContext) => unknown;

/** Something that is only an annotation and a decorator. */
function decoratorOnly<F>(annotation: Annotation, decorate: Decorate): F {
	return annotate((target: unknown, second?: unknown) => {
		if (isDecoratorContext(second)) return decorate(target as never, second);
		if (isKey(second) && typeof target === "object" && target !== null) {
			storeAnnotation(target, second, annotation);
			return undefined;
		}
		throw new Error(
			`sobx: ${annotation.type} can only be used as an annotation or decorator.`,
		);
	}, annotation) as unknown as F;
}

/** Legacy (`experimentalDecorators`) decorators. */
export interface LegacyDecorator {
	// biome-ignore lint/suspicious/noExplicitAny: as TypeScript's PropertyDecorator / MethodDecorator
	(target: object, key: string | symbol, descriptor?: any): any;
}

/** `@observable accessor x` (also usable in annotation maps, and as a legacy decorator). */
export interface AccessorAnnotation extends LegacyDecorator {
	<This, V>(
		value: ClassAccessorDecoratorTarget<This, V>,
		context: ClassAccessorDecoratorContext<This, V>,
	): ClassAccessorDecoratorResult<This, V>;
}

/** `@computed get x()` (also usable in annotation maps, and as a legacy decorator). */
export interface GetterAnnotation extends LegacyDecorator {
	<This, V>(
		getter: (this: This) => V,
		context: ClassGetterDecoratorContext<This, V>,
	): (this: This) => V;
}

/** `@action m()` (also usable in annotation maps, and as a legacy decorator). */
export interface MethodAnnotation extends LegacyDecorator {
	<This, A extends unknown[], R>(
		fn: (this: This, ...args: A) => R,
		context: ClassMethodDecoratorContext<This, (this: This, ...args: A) => R>,
	): (this: This, ...args: A) => R;
	<This, V>(
		value: undefined,
		context: ClassFieldDecoratorContext<This, V>,
	): (this: This, value: V) => V;
}

// -- observable -----------------------------------------------------------------------------

export interface ObservableFn extends AccessorAnnotation {
	<T>(value: T[], overrides?: null, options?: ArrayOptions): ObservableArray<T>;
	<T>(value: T[], options?: ArrayOptions): ObservableArray<T>;
	<K, V>(
		value: Map<K, V>,
		overrides?: null,
		options?: CollectionOptions,
	): ObservableMap<K, V>;
	<K, V>(value: Map<K, V>, options?: CollectionOptions): ObservableMap<K, V>;
	<T>(
		value: Set<T>,
		overrides?: null,
		options?: CollectionOptions,
	): ObservableSet<T>;
	<T>(value: Set<T>, options?: CollectionOptions): ObservableSet<T>;
	<T extends object>(
		value: T,
		overrides?: AnnotationsMap<T>,
		options?: ObservableOptions,
	): T;
	/** `observable.box(value, options?)`: a single observable value. */
	box<T>(value: T, options?: BoxOptions<T>): ObservableValue<T>;
	/** `observable.object(value, overrides?, options?)`: an observable copy of a plain object. */
	object<T extends object>(
		value: T,
		overrides?: AnnotationsMap<T>,
		options?: ObservableOptions,
	): T;
	/** `observable.map(entries?, options?)`: an observable Map. */
	map<K, V>(
		entries?: MapEntries<K, V>,
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

/**
 * `observable(object, overrides?, options?)`: an observable copy of a plain object. Also an
 * annotation (`{ x: observable }`) and a decorator (`@observable accessor x`, or `@observable x`
 * with legacy decorators).
 */
export const observable = annotate(
	(value: unknown, second?: unknown, options?: ObservableOptions) => {
		if (isDecoratorContext(second)) {
			return decorateObservable(observableDeep, second);
		}
		if (isKey(second)) {
			storeAnnotation(value as object, second, observableDeep);
			return undefined;
		}
		return createObservable(value, second, options);
	},
	observableDeep,
) as ObservableFn;
for (const [name, annotation] of Object.entries({
	ref: observableRef,
	shallow: observableShallow,
	struct: observableStruct,
	deep: observableAnnotation("observable.deep", deep),
})) {
	(observable as unknown as Record<string, unknown>)[name] = decoratorOnly(
		annotation,
		(_value, context) => decorateObservable(annotation, context),
	);
}
observable.box = createBox;
observable.object = createObservableObject;
observable.map = (entries, options) => new ObservableMap(entries, options);
observable.set = (values, options) => new ObservableSet(values, options);
observable.array = (values, options) =>
	createObservableArray(values ?? [], options);

// -- computed -------------------------------------------------------------------------------

export interface ComputedFn extends GetterAnnotation {
	<T>(fn: () => T, options?: ComputedOptions<T>): Computed<T>;
	/** `computed({ keepAlive: true })`: an annotation / decorator with options. */
	// biome-ignore lint/suspicious/noExplicitAny: options for a computed of any type
	(options: ComputedOptions<any>): GetterAnnotation;
	struct: GetterAnnotation;
}

/**
 * `computed(fn, options?)`: a computed value (read with `.get()`). Also an annotation and a
 * getter decorator (`@computed get x()`, `@computed({ keepAlive: true }) get x()`).
 */
export const computed = annotate((first: unknown, second?: unknown) => {
	if (isDecoratorContext(second)) {
		return decorateComputed(computedPlain, first as () => unknown, second);
	}
	if (isKey(second)) {
		storeAnnotation(first as object, second, computedPlain);
		return undefined;
	}
	if (isPlainObject(first)) {
		const annotation = computedAnnotation(
			"computed",
			first as ComputedOptions<unknown>,
		);
		return decoratorOnly(annotation, (getter, context) =>
			decorateComputed(annotation, getter, context),
		);
	}
	if (typeof first !== "function") {
		throw new Error(
			"sobx: First argument to `computed` should be an expression.",
		);
	}
	return createComputed(
		first as () => unknown,
		second as ComputedOptions<unknown> | undefined,
	);
}, computedPlain) as ComputedFn;
computed.struct = decoratorOnly(computedStruct, (getter, context) =>
	decorateComputed(computedStruct, getter, context),
);

// -- action ---------------------------------------------------------------------------------

export interface ActionFn extends MethodAnnotation {
	<F extends AnyFn>(fn: F): F;
	<F extends AnyFn>(name: string, fn: F): F;
	/** `action("name")`: an annotation / decorator with a name. */
	(name: string): MethodAnnotation;
	bound: MethodAnnotation;
}

function actionFactory(annotation: ActionAnnotation, bound: ActionAnnotation) {
	const { auto } = annotation.options;
	const factory = annotate((first: unknown, second?: unknown) => {
		if (isDecoratorContext(second)) {
			return decorateAction(annotation, first as AnyFn, second);
		}
		// action(fn)
		if (typeof first === "function") {
			const fn = first as AnyFn;
			return createAction(fn.name || "<unnamed action>", fn, auto);
		}
		// action("name", fn)
		if (typeof second === "function") {
			return createAction(String(first), second as AnyFn, auto);
		}
		// @action
		if (isKey(second)) {
			storeAnnotation(first as object, second, annotation);
			return undefined;
		}
		// action("name")
		if (isKey(first)) {
			const named = actionAnnotation(annotation.type, {
				name: String(first),
				auto,
			});
			return decoratorOnly(named, (fn, context) =>
				decorateAction(named, fn, context),
			);
		}
		throw new Error("sobx: Invalid arguments for `action`");
	}, annotation) as unknown as ActionFn;
	factory.bound = decoratorOnly(bound, (fn, context) =>
		decorateAction(bound, fn, context),
	);
	return factory;
}

/**
 * `action(fn)` / `action(name, fn)`: wrap a function so it runs batched and untracked. Also an
 * annotation and a method decorator (`@action m()`, `@action.bound m()`, `@action("name") m()`).
 */
export const action = actionFactory(actionPlain, actionBound);

/** Like {@link action}, but part of the derivation when called in one. */
export const autoAction = actionFactory(autoActionPlain, autoActionBound);

// -- flow -----------------------------------------------------------------------------------

/** `@flow *m()` (also usable in annotation maps, and as a legacy decorator). */
export interface FlowAnnotation extends LegacyDecorator {
	<This, A extends unknown[], R>(
		fn: (this: This, ...args: A) => Generator<unknown, R, unknown>,
		context: ClassMethodDecoratorContext<
			This,
			(this: This, ...args: A) => Generator<unknown, R, unknown>
		>,
	): (this: This, ...args: A) => FlowPromise<R>;
}

export interface FlowFn extends FlowAnnotation {
	<A extends unknown[], R>(
		generator: (
			...args: A
		) => Generator<unknown, R, unknown> | AsyncGenerator<unknown, R, unknown>,
	): (...args: A) => FlowPromise<R>;
	bound: FlowAnnotation;
}

/**
 * `flow(function* () {...})`: an async action written as a generator; each step between
 * `yield`s runs as an action. Also an annotation and a method decorator (`@flow *m()`,
 * `@flow.bound *m()`).
 */
export const flow = annotate((first: unknown, second?: unknown) => {
	if (isDecoratorContext(second)) {
		return decorateFlow(flowPlain, first as AnyFn, second);
	}
	if (isKey(second)) {
		storeAnnotation(first as object, second, flowPlain);
		return undefined;
	}
	return createFlow(first as never);
}, flowPlain) as unknown as FlowFn;
flow.bound = decoratorOnly(flowBound, (fn, context) =>
	decorateFlow(flowBound, fn, context),
);

/** Marks a method or getter that overrides an annotated one (its annotation is inherited). */
export const override: MethodAnnotation & GetterAnnotation = decoratorOnly(
	overrideAnnotation,
	() => undefined,
);
