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
