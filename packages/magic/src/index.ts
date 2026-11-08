/**
 * The MobX-compatible API, as you write it. These exports are not meant to run: the sobx
 * compiler redirects imports of "@sobx/magic" to `@sobx/runtime` (and compiles local
 * observables to a faster form). If one of them is ever called, the compiler was not enabled
 * for that file, and it throws to say so.
 *
 * The types are the runtime's, so code type-checks exactly as it will run.
 */
import type * as runtime from "@sobx/runtime";

export type {
	Annotation,
	AnnotationsMap,
	AnnotationValue,
	AutorunOptions,
	Computed,
	ComputedOptions,
	Disposer,
	ObservableOptions,
	Reaction,
	ReactionOptions,
} from "@sobx/runtime";

function notCompiled(name: string): never {
	throw new Error(
		`sobx: ${name} was not compiled. Ensure the sobx compiler is enabled for this file.`,
	);
}

/** A function that throws `notCompiled`, with the same properties (e.g. `observable.ref`). */
function placeholder<T>(name: string, members: string[] = []): T {
	const fn = () => notCompiled(`${name}()`);
	for (const member of members) {
		Object.defineProperty(fn, member, {
			value: () => notCompiled(`${name}.${member}`),
		});
	}
	return fn as T;
}

export const observable: runtime.ObservableFn = placeholder("observable", [
	"ref",
	"shallow",
	"struct",
	"deep",
]);
export const computed: runtime.ComputedFn = placeholder("computed", ["struct"]);
export const action: runtime.ActionFn = placeholder("action", ["bound"]);
export const runInAction =
	placeholder<typeof runtime.runInAction>("runInAction");
export const reaction = placeholder<typeof runtime.reaction>("reaction");
export const autorun = placeholder<typeof runtime.autorun>("autorun");
export const makeObservable =
	placeholder<typeof runtime.makeObservable>("makeObservable");
export const makeAutoObservable =
	placeholder<typeof runtime.makeAutoObservable>("makeAutoObservable");
