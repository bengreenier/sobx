/** Type-checked only: standard (2022.3) decorators. */
import {
	action,
	computed,
	flow,
	flowResult,
	observable,
} from "../../src/index.js";

export class Store {
	@observable accessor count = 1;
	@observable.ref accessor ref: { a: number } | null = null;
	@computed get total() {
		return this.count + 1;
	}
	@computed.struct get struct() {
		return { a: 1 };
	}
	@computed({ keepAlive: true }) get kept() {
		return 1;
	}
	@action inc(by: number) {
		this.count += by;
	}
	@action.bound bound() {}
	@action("named") named() {}
	@action field = () => {};
	@flow *load(id: string): Generator<Promise<string>, number, string> {
		const text = yield Promise.resolve(id);
		return text.length;
	}
	@flow.bound *other(): Generator<unknown, void, unknown> {}
}
export const loaded: Promise<number> = flowResult(new Store().load("a"));
