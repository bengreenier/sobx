/**
 * Virtual MobX-compatible API. These exports are not meant to be called at runtime —
 * the sobx compiler replaces usages with compiled code. Use the sobx compiler when
 * importing from "sobx".
 */

export function observable<T extends object>(_value: T): T {
	throw new Error(
		"sobx: observable() was not compiled. Ensure the sobx compiler is enabled for this file.",
	);
}

export function reaction<T>(
	_dataFn: () => T,
	_effectFn: (value: T) => void,
	_options?: { fireImmediately?: boolean },
): () => void {
	throw new Error(
		"sobx: reaction() was not compiled. Ensure the sobx compiler is enabled for this file.",
	);
}

export function runInAction<T>(_fn: () => T): T {
	throw new Error(
		"sobx: runInAction() was not compiled. Ensure the sobx compiler is enabled for this file.",
	);
}
