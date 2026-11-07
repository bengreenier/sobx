// Placeholder API with a branded observable type, as the `sobx` package could declare it.
declare const OBSERVABLE: unique symbol;
export type Observable<T> = T & { readonly [OBSERVABLE]: true };
export declare function observable<T extends object>(value: T): Observable<T>;
export declare function makeAutoObservable<T extends object>(target: T): T;
export declare function autorun(fn: () => void): () => void;
