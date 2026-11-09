import {
	isObservableArray,
	isObservableMap,
	isObservableObject,
	untracked,
} from "@sobx/runtime";

/** A prop-types validator (as in the `prop-types` package). */
export type Validator = (
	props: Record<string, unknown>,
	propName: string,
	componentName: string,
	location: string,
	propFullName: string,
	...rest: unknown[]
) => Error | null;

/** A validator with an `isRequired` variant. */
export interface Requireable extends Validator {
	isRequired: Validator;
}

function createChainableTypeChecker(validator: Validator): Requireable {
	function checkType(
		isRequired: boolean,
		props: Record<string, unknown>,
		propName: string,
		componentName: string,
		location: string,
		propFullName: string,
		...rest: unknown[]
	): Error | null {
		return untracked(() => {
			const component = componentName || "<<anonymous>>";
			const fullName = propFullName || propName;
			if (props[propName] == null) {
				if (isRequired) {
					const actual = props[propName] === null ? "null" : "undefined";
					return new Error(
						`The ${location} \`${fullName}\` is marked as required in \`${component}\`, but its value is \`${actual}\`.`,
					);
				}
				return null;
			}
			return validator(props, propName, component, location, fullName, ...rest);
		});
	}
	const chained = checkType.bind(null, false) as Requireable;
	chained.isRequired = checkType.bind(null, true);
	return chained;
}

function getPropType(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value instanceof RegExp) return "object";
	return typeof value;
}

function getPreciseType(value: unknown): string {
	const type = getPropType(value);
	if (type === "object") {
		if (value instanceof Date) return "date";
		if (value instanceof RegExp) return "regexp";
	}
	return type;
}

type ObservableKind = "Array" | "Object" | "Map";
const CHECKERS: Record<ObservableKind, (value: unknown) => boolean> = {
	Array: isObservableArray,
	Object: isObservableObject,
	Map: isObservableMap,
};

function observableTypeChecker(
	allowNativeType: boolean,
	kind: ObservableKind,
): Requireable {
	return createChainableTypeChecker(
		(props, propName, componentName, _location, propFullName) =>
			untracked(() => {
				const value = props[propName];
				if (allowNativeType && getPropType(value) === kind.toLowerCase()) {
					return null;
				}
				if (CHECKERS[kind](value)) return null;
				const native = allowNativeType
					? ` or javascript \`${kind.toLowerCase()}\``
					: "";
				return new Error(
					`Invalid prop \`${propFullName}\` of type \`${getPreciseType(value)}\` supplied to \`${componentName}\`, expected \`mobx.Observable${kind}\`${native}.`,
				);
			}),
	);
}

function observableArrayOfTypeChecker(
	allowNativeType: boolean,
	typeChecker: Validator,
): Requireable {
	return createChainableTypeChecker(
		(props, propName, componentName, location, propFullName, ...rest) =>
			untracked(() => {
				if (typeof typeChecker !== "function") {
					return new Error(
						`Property \`${propFullName}\` of component \`${componentName}\` has invalid PropType notation.`,
					);
				}
				const error = observableTypeChecker(allowNativeType, "Array")(
					props,
					propName,
					componentName,
					location,
					propFullName,
				);
				if (error) return error;
				const value = props[propName] as unknown[];
				for (let i = 0; i < value.length; i++) {
					const itemError = typeChecker(
						value as unknown as Record<string, unknown>,
						String(i),
						componentName,
						location,
						`${propFullName}[${i}]`,
						...rest,
					);
					if (itemError instanceof Error) return itemError;
				}
				return null;
			}),
	);
}

/**
 * prop-types validators for observables, as in mobx-react: `observableArray`,
 * `observableArrayOf(type)`, `observableMap`, `observableObject`, and the variants that also
 * accept plain values (`arrayOrObservableArray`, `arrayOrObservableArrayOf(type)`,
 * `objectOrObservableObject`). Each has an `isRequired` variant.
 */
export const PropTypes = {
	observableArray: observableTypeChecker(false, "Array"),
	observableArrayOf: (type: Validator) =>
		observableArrayOfTypeChecker(false, type),
	observableMap: observableTypeChecker(false, "Map"),
	observableObject: observableTypeChecker(false, "Object"),
	arrayOrObservableArray: observableTypeChecker(true, "Array"),
	arrayOrObservableArrayOf: (type: Validator) =>
		observableArrayOfTypeChecker(true, type),
	objectOrObservableObject: observableTypeChecker(true, "Object"),
};
