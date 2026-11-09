// A store in its own module, as in most applications (compiled: see vite.config.ts).
import { observable } from "@sobx/magic";

export const shop = observable({
	stock: {} as Record<string, number>,
	cart: [] as string[],
});
