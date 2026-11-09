// The bindings target any environment React runs in (browsers, React Native, servers); only
// these globals are needed.
declare const console: {
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
};
declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(handle: number | undefined): void;
