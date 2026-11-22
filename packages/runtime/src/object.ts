/** What's behind an observable object or class instance. */
import { Computed, type ComputedOptions } from "./computed.js";
import {
	$mobx,
	checkWrite,
	DEV,
	Dep,
	type Equals,
	endBatch,
	globalState,
	type Named,
	nextId,
	notifyOwners,
	observableValues,
	proxyOf,
	rawOf,
	reportChanged,
	reportObserved,
	startBatch,
	stringifyKey,
} from "./core.js";
import { type Enhancer, isPlainObject } from "./enhance.js";
import {
	addInterceptor,
	addListener,
	type ChangeListener,
	type Hooks,
	type Interceptor,
	interceptChange,
	isSpying,
	type Lambda,
	notifyListeners,
	report,
	type SpyEvent,
	spyReportEnd,
	spyReportStart,
} from "./spy.js";
import { ObservableValue, UNCHANGED } from "./value.js";

/**
 * What an annotation does to a member: `make` (from `makeObservable`: the member may be on a
 * prototype) and `extend` (a new member). `null` / `"cancel"`: an interceptor refused.
 */
export interface Annotation {
	readonly type: string;
	make(
		adm: ObjectAdministration,
		key: PropertyKey,
		descriptor: PropertyDescriptor,
		source: object,
	): "cancel" | "break" | "continue";
	extend(
		adm: ObjectAdministration,
		key: PropertyKey,
		descriptor: PropertyDescriptor,
		trap: boolean,
	): boolean | null;
}

/** Annotations left on prototypes by legacy decorators. */
export const storedAnnotations = Symbol("sobx.storedAnnotations");

type Stored = { [storedAnnotations]?: Record<PropertyKey, Annotation> };

const descriptors = new Map<
	PropertyKey,
	{ get(): unknown; set(v: unknown): void }
>();

/** The accessors of observable and computed properties (shared by every object). */
function accessors(key: PropertyKey) {
	let accessor = descriptors.get(key);
	if (!accessor) {
		accessor = {
			get(this: { [$mobx]: ObjectAdministration }) {
				return this[$mobx].read(key);
			},
			set(this: { [$mobx]: ObjectAdministration }, value: unknown) {
				this[$mobx].write(key, value);
			},
		} as { get(): unknown; set(v: unknown): void };
		descriptors.set(key, accessor);
	}
	return accessor;
}

/** A property's presence, read by `has()` and by reads of keys that don't exist yet. */
class Presence extends Dep {
	constructor(
		name: string,
		public present: boolean,
	) {
		super(undefined, name);
	}
	update(present: boolean): void {
		if (this.present === present) return;
		this.present = present;
		reportChanged(this);
	}
}

/** The object can't be given the property. */
const REFUSED = Symbol("refused");

export class ObjectAdministration implements Hooks, Named {
	interceptors: Interceptor[] | null = null;
	listeners: ChangeListener[] | null = null;
	/** The observable and computed properties. */
	readonly values = new Map<
		PropertyKey,
		ObservableValue<unknown> | Computed<unknown>
	>();
	readonly keysDep: Dep;
	readonly isPlain: boolean;
	private presence: Map<PropertyKey, Presence> | null = null;
	/** Which annotation each member has (development builds). */
	private readonly applied: Record<PropertyKey, string> = Object.create(null);

	constructor(
		readonly target: object,
		readonly name: string,
		readonly defaultAnnotation: Annotation,
	) {
		this.isPlain = isPlainObject(target);
		this.keysDep = new Dep(undefined, this, "keys");
	}

	/** What user code sees. */
	get object(): object {
		return proxyOf(this.target);
	}

	get atom(): Dep {
		return this.keysDep;
	}

	memberName(key: PropertyKey): string {
		return `${this.name}.${stringifyKey(key)}`;
	}

	// -- values -------------------------------------------------------------------------------

	read(key: PropertyKey): unknown {
		return this.values.get(key)?.get();
	}

	/** Write an existing observable or computed property. `null`: refused by an interceptor. */
	write(key: PropertyKey, value: unknown): boolean | null {
		const observable = this.values.get(key);
		if (observable === undefined) return false;
		if (observable instanceof Computed) {
			observable.set(value);
			return true;
		}
		let given = value;
		if (this.interceptors !== null) {
			const change = interceptChange(this, {
				type: "update",
				object: this.object,
				name: key,
				newValue: value,
			});
			if (!change) return null;
			given = change.newValue;
		}
		const next = observable.prepareNew(given);
		if (next === UNCHANGED) return true;
		if (this.listeners === null && globalState.spying === 0) {
			observable.setNew(next);
			return true;
		}
		const previous = observable.current;
		report(
			this,
			() => ({
				type: "update",
				observableKind: "object",
				debugObjectName: this.name,
				object: this.object,
				oldValue: previous,
				name: key,
				newValue: next,
			}),
			() => observable.setNew(next),
		);
		return true;
	}

	/** `object[key]`, tracked if the key doesn't exist yet. */
	get(key: PropertyKey): unknown {
		const target = this.target as Record<PropertyKey, unknown>;
		if (globalState.tracking !== null && !Object.hasOwn(target, key)) {
			this.has(key);
		}
		return target[key];
	}

	/** `object[key] = value`: a new key becomes an observable property. */
	set(key: PropertyKey, value: unknown, trap = false): boolean | null {
		const target = this.target as Record<PropertyKey, unknown>;
		if (this.values.has(key)) return this.write(key, value);
		if (Object.hasOwn(target, key)) {
			if (trap) return Reflect.set(target, key, value);
			target[key] = value;
			return true;
		}
		return this.extend(
			key,
			{ value, enumerable: true, writable: true, configurable: true },
			this.defaultAnnotation,
			trap,
		);
	}

	/** `key in object`. Tracked, including for keys that don't exist yet. */
	has(key: PropertyKey): boolean {
		if (globalState.tracking === null) return key in this.target;
		this.presence ??= new Map();
		let presence = this.presence.get(key);
		if (!presence) {
			presence = new Presence(`${this.memberName(key)}?`, key in this.target);
			this.presence.set(key, presence);
		}
		reportObserved(presence);
		return presence.present;
	}

	keys(): string[] {
		reportObserved(this.keysDep);
		return Object.keys(this.target);
	}

	ownKeys(): PropertyKey[] {
		reportObserved(this.keysDep);
		return Reflect.ownKeys(this.target);
	}

	// -- annotating ---------------------------------------------------------------------------

	private assertAnnotable(annotation: Annotation, key: PropertyKey): void {
		if (!DEV || annotation.type === "override") return;
		const current = this.applied[key];
		if (current === undefined) return;
		throw new Error(
			`sobx: Cannot apply '${annotation.type}' to '${this.memberName(key)}':\nThe field is already annotated with '${current}'.\nRe-annotating fields is not allowed.\nUse 'override' annotation for methods overridden by subclass.`,
		);
	}

	private recordApplied(annotation: Annotation, key: PropertyKey): void {
		if (DEV) this.applied[key] = annotation.type;
		// Applied once, even if a subclass's constructor asks again.
		if (!this.isPlain && annotation.type !== "override") {
			const own = this.target as Stored;
			if (Object.hasOwn(own, storedAnnotations)) {
				delete own[storedAnnotations]?.[key];
			}
		}
	}

	isApplied(key: PropertyKey): boolean {
		return Object.hasOwn(this.applied, key);
	}

	make(key: PropertyKey, annotation: Annotation | boolean): void {
		if (annotation === false) return;
		const effective = annotation === true ? this.defaultAnnotation : annotation;
		this.assertAnnotable(effective, key);
		if (!(key in this.target)) {
			// Decorated in a subclass, whose constructor hasn't run yet.
			if ((this.target as Stored)[storedAnnotations]?.[key]) return;
			throw new Error(
				`sobx: Cannot apply '${effective.type}' to '${this.memberName(key)}': Field not found.`,
			);
		}
		let source: object | null = this.target;
		while (source && source !== Object.prototype) {
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (descriptor) {
				const outcome = effective.make(this, key, descriptor, source);
				if (outcome === "cancel") return;
				if (outcome === "break") break;
			}
			source = Object.getPrototypeOf(source);
		}
		this.recordApplied(effective, key);
	}

	extend(
		key: PropertyKey,
		descriptor: PropertyDescriptor,
		annotation: Annotation | boolean,
		trap = false,
	): boolean | null {
		if (annotation === false) return this.defineProperty(key, descriptor, trap);
		const effective = annotation === true ? this.defaultAnnotation : annotation;
		this.assertAnnotable(effective, key);
		const outcome = effective.extend(this, key, descriptor, trap);
		if (outcome) this.recordApplied(effective, key);
		return outcome;
	}

	// -- defining -----------------------------------------------------------------------------

	private change(type: string, key: PropertyKey, more: object): SpyEvent {
		return { type, object: this.object, name: key, ...more };
	}

	private define(
		key: PropertyKey,
		descriptor: PropertyDescriptor,
		trap: boolean,
	): boolean {
		if (trap) return Reflect.defineProperty(this.target, key, descriptor);
		Object.defineProperty(this.target, key, descriptor);
		return true;
	}

	/** Define `key`: replaces what's there, and asks the interceptors. */
	private add(
		key: PropertyKey,
		value: unknown,
		define: (adm: this, value: unknown) => unknown,
	): boolean | null {
		checkWrite(this.keysDep, this.keysDep);
		startBatch();
		try {
			if (Object.hasOwn(this.target, key)) {
				const deleted = this.delete(key);
				if (!deleted) return deleted;
			}
			let given = value;
			if (this.interceptors !== null) {
				const change = interceptChange(
					this,
					this.change("add", key, { newValue: value }),
				);
				if (!change) return null;
				given = change.newValue;
			}
			const added = define(this, given);
			if (added === REFUSED) return false;
			if (this.listeners !== null || globalState.spying !== 0) {
				report(
					this,
					() =>
						this.change("add", key, {
							observableKind: "object",
							debugObjectName: this.name,
							newValue: added,
						}),
					() => {},
				);
			}
			this.presence?.get(key)?.update(true);
			reportChanged(this.keysDep);
			notifyOwners(this.target);
		} finally {
			endBatch();
		}
		return true;
	}

	/** A plain (not observable) property. */
	defineProperty(
		key: PropertyKey,
		descriptor: PropertyDescriptor,
		trap = false,
	): boolean | null {
		return this.add(key, descriptor.value, (adm, value) => {
			const changed = descriptor.value !== value;
			return adm.define(
				key,
				changed ? { ...descriptor, value } : descriptor,
				trap,
			)
				? value
				: REFUSED;
		});
	}

	private get configurable(): boolean {
		return globalState.safeDescriptors ? this.isPlain : true;
	}

	defineObservable(
		key: PropertyKey,
		value: unknown,
		enhancer: Enhancer,
		equals: Equals,
		trap = false,
	): boolean | null {
		return this.add(key, value, (adm, given) => {
			const { get, set } = accessors(key);
			const configurable = adm.configurable;
			if (
				!adm.define(key, { configurable, enumerable: true, get, set }, trap)
			) {
				return REFUSED;
			}
			const observable = new ObservableValue(given, enhancer, equals, adm, key);
			adm.values.set(key, observable);
			return observable.current;
		});
	}

	defineComputed(
		key: PropertyKey,
		getter: () => unknown,
		options: ComputedOptions<unknown>,
		trap = false,
	): boolean | null {
		return this.add(key, undefined, (adm) => {
			const { get, set } = accessors(key);
			const configurable = adm.configurable;
			if (
				!adm.define(key, { configurable, enumerable: false, get, set }, trap)
			) {
				return REFUSED;
			}
			adm.values.set(key, adm.createComputed(key, getter, options));
			return undefined;
		});
	}

	createComputed(
		key: PropertyKey,
		getter: () => unknown,
		options: ComputedOptions<unknown>,
	): Computed<unknown> {
		return new Computed(
			getter,
			{
				...options,
				name:
					options.name || (DEV ? this.memberName(key) : "ObservableObject.key"),
			},
			this.object,
		);
	}

	/** `delete object[key]`. `null`: refused by an interceptor. */
	delete(key: PropertyKey, trap = false): boolean | null {
		checkWrite(this.keysDep, this.keysDep);
		const target = this.target as Record<PropertyKey, unknown>;
		if (!Object.hasOwn(target, key)) return true;
		if (this.interceptors !== null) {
			const change = interceptChange(this, this.change("remove", key, {}));
			if (!change) return null;
		}
		startBatch();
		try {
			const observable = this.values.get(key);
			let value: unknown;
			const notify = this.listeners !== null;
			const spying = isSpying();
			if (!observable && (notify || spying)) {
				value = Object.getOwnPropertyDescriptor(target, key)?.value;
			}
			if (trap) {
				if (!Reflect.deleteProperty(target, key)) return false;
			} else {
				delete target[key];
			}
			if (DEV) delete this.applied[key];
			if (observable) {
				this.values.delete(key);
				if (observable instanceof ObservableValue) value = observable.current;
				// What read it must re-run (and read the key as missing).
				reportChanged(
					observable instanceof Computed ? observable.dep : observable,
				);
			}
			reportChanged(this.keysDep);
			this.presence?.get(key)?.update(key in target);
			notifyOwners(target);
			if (notify || spying) {
				const change = this.change("remove", key, {
					observableKind: "object",
					debugObjectName: this.name,
					oldValue: value,
				});
				if (spying) spyReportStart(change);
				notifyListeners(this, change);
				if (spying) spyReportEnd();
			}
		} finally {
			endBatch();
		}
		return true;
	}

	// -- observe / intercept ------------------------------------------------------------------

	observe(listener: ChangeListener, fireImmediately?: boolean): Lambda {
		if (fireImmediately) {
			throw new Error(
				"sobx: `observe` doesn't support the fire immediately property for observable objects.",
			);
		}
		return addListener(this, listener);
	}

	intercept(handler: Interceptor): Lambda {
		return addInterceptor(this, handler);
	}
}

/** The administration of an observable object / class instance, if `value` is one. */
export function administrationOf(
	value: unknown,
): ObjectAdministration | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const adm = (value as { [$mobx]?: unknown })[$mobx];
	return adm instanceof ObjectAdministration ? adm : undefined;
}

/** The administration of `target`, created if it has none. */
export function administer(
	target: object,
	defaultAnnotation: Annotation,
	options: { name?: string } | undefined,
): ObjectAdministration {
	const raw = rawOf(target);
	const existing = (raw as { [$mobx]?: unknown })[$mobx];
	if (existing !== undefined && !(existing instanceof ObjectAdministration)) {
		throw new Error(
			`sobx: Cannot convert '${(existing as Named).name}' into observable object:\nThe target is already observable of different type.\nExtending builtins is not supported.`,
		);
	}
	if (Object.hasOwn(raw, $mobx)) {
		if (DEV && options) {
			throw new Error(
				"sobx: Options can't be provided for already observable objects.",
			);
		}
		return existing as ObjectAdministration;
	}
	if (!Object.isExtensible(raw)) {
		throw new Error(
			"sobx: Cannot make the designated object observable; it is not extensible",
		);
	}
	const kind = isPlainObject(raw)
		? "ObservableObject"
		: (raw as object).constructor?.name || "ObservableObject";
	const adm = new ObjectAdministration(
		raw,
		options?.name ?? (DEV ? `${kind}@${nextId()}` : "ObservableObject"),
		defaultAnnotation,
	);
	Object.defineProperty(raw, $mobx, {
		value: adm,
		configurable: true,
		writable: true,
	});
	observableValues.add(raw);
	return adm;
}
