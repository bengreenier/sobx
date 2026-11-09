/** Shallow equality of two props / state objects (as React's `PureComponent`). */
export function shallowEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (
		typeof a !== "object" ||
		a === null ||
		typeof b !== "object" ||
		b === null
	) {
		return false;
	}
	const keysA = Object.keys(a);
	if (keysA.length !== Object.keys(b).length) return false;
	for (const key of keysA) {
		if (
			!Object.hasOwn(b, key) ||
			!Object.is(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
			)
		) {
			return false;
		}
	}
	return true;
}

const HOIST_BLOCKLIST = new Set([
	"$$typeof",
	"render",
	"compare",
	"type",
	"childContextTypes",
	"contextType",
	"contextTypes",
	"defaultProps",
	"getDefaultProps",
	"getDerivedStateFromError",
	"getDerivedStateFromProps",
	"mixins",
	"displayName",
	"propTypes",
	"length",
	"name",
	"prototype",
	"caller",
	"arguments",
]);

/** Copy a component's static properties to the component wrapping it. */
export function copyStaticProperties(base: object, target: object): void {
	for (const key of Object.getOwnPropertyNames(base)) {
		if (HOIST_BLOCKLIST.has(key) || Object.hasOwn(target, key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(base, key);
		if (descriptor) Object.defineProperty(target, key, descriptor);
	}
}

// Patching lifecycle methods (as mobx-react does), so that `observer` and `disposeOnUnmount`
// can both add to `componentWillUnmount`, in either order, alongside the component's own
// (which may be defined on the class or assigned later, on the prototype or the instance).

const mixinsKey = Symbol("sobxPatchMixins");
/** Methods already replaced by a patching accessor, per object. */
const patched = new WeakMap<object, Set<string>>();

// biome-ignore lint/suspicious/noExplicitAny: methods of arbitrary components
type AnyFn = (this: any, ...args: any[]) => any;

interface Mixins {
	/** Calls in progress (mixins run once, when the outermost call ends). */
	locks: number;
	methods: AnyFn[];
}

type Patchable = Record<PropertyKey, unknown> & {
	[mixinsKey]?: Record<string, Mixins>;
};

function getMixins(target: Patchable, methodName: string): Mixins {
	target[mixinsKey] ??= {};
	const mixins = target[mixinsKey];
	mixins[methodName] ??= { locks: 0, methods: [] };
	return mixins[methodName];
}

function wrapFunction(realMethod: AnyFn | undefined, mixins: Mixins): AnyFn {
	return function (this: unknown, ...args: unknown[]) {
		mixins.locks++;
		try {
			return realMethod?.apply(this, args);
		} finally {
			mixins.locks--;
			if (mixins.locks === 0) {
				for (const mixin of mixins.methods) mixin.apply(this, args);
			}
		}
	};
}

function createDefinition(
	target: object,
	methodName: string,
	enumerable: boolean | undefined,
	mixins: Mixins,
	originalMethod: AnyFn | undefined,
): PropertyDescriptor {
	let wrapped = wrapFunction(originalMethod, mixins);
	let names = patched.get(target);
	if (!names) {
		names = new Set();
		patched.set(target, names);
	}
	names.add(methodName);
	return {
		get() {
			return wrapped;
		},
		set(this: object, value: AnyFn) {
			if (this === target) {
				wrapped = wrapFunction(value, mixins);
			} else {
				// Assigned on an instance (or a subclass prototype): patch it there.
				Object.defineProperty(
					this,
					methodName,
					createDefinition(this, methodName, enumerable, mixins, value),
				);
			}
		},
		configurable: true,
		enumerable,
	};
}

/** Run `mixin` after `target[methodName]` (which may not exist yet, or be replaced later). */
export function patch(target: object, methodName: string, mixin: AnyFn): void {
	const patchable = target as Patchable;
	const mixins = getMixins(patchable, methodName);
	if (!mixins.methods.includes(mixin)) mixins.methods.push(mixin);
	if (patched.get(target)?.has(methodName)) return;
	const existing = Object.getOwnPropertyDescriptor(target, methodName);
	Object.defineProperty(
		target,
		methodName,
		createDefinition(
			target,
			methodName,
			existing?.enumerable,
			mixins,
			patchable[methodName] as AnyFn | undefined,
		),
	);
}
