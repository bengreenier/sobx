import { action, computed, observable } from "@sobx/magic";

// An exported, decorator-based class store: made observable by @sobx/runtime.
export class Todos {
	@observable accessor items: string[] = [];
	@observable accessor filter = "";

	@computed get visible(): string[] {
		return this.items.filter((item) => item.includes(this.filter));
	}

	@action add(item: string) {
		this.items.push(item); // arrays are deep observables
	}
}
