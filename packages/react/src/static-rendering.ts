let staticRendering = false;

/**
 * Turn static rendering on or off. With it on (for server-side rendering), `observer`
 * components render once and don't react to changes, so nothing leaks on the server.
 */
export function enableStaticRendering(enable: boolean): void {
	staticRendering = enable;
}

/** Whether static rendering is on (see {@link enableStaticRendering}). */
export function isUsingStaticRendering(): boolean {
	return staticRendering;
}

/** @deprecated Use {@link enableStaticRendering}. */
export function useStaticRendering(enable: boolean): void {
	if (DEV) {
		console.warn(
			"[sobx-react] 'useStaticRendering' is deprecated, use 'enableStaticRendering' instead",
		);
	}
	enableStaticRendering(enable);
}

declare const process: { env: Record<string, string | undefined> };

/** Development build? Bundlers replace `process.env.NODE_ENV`. */
export const DEV: boolean = (() => {
	try {
		return process.env.NODE_ENV !== "production";
	} catch {
		return true;
	}
})();
