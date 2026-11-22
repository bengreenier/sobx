/** In its own file: `reactionScheduler` can't be unset. */
import * as mobx from "mobx";
import * as sobx from "./index.js";

it("configure({ reactionScheduler }) runs reactions, as in MobX", () => {
	const run = (api: typeof mobx | typeof sobx) => {
		const out: unknown[] = [];
		const queue: Array<() => void> = [];
		api.configure({
			enforceActions: "never",
			reactionScheduler: (fn) => {
				queue.push(fn);
			},
		});
		const o = (api as typeof mobx).observable.box(1);
		api.autorun(() => {
			out.push(o.get());
		});
		o.set(2);
		out.push("queued", queue.length > 0);
		for (const fn of queue.splice(0)) fn();
		o.set(3);
		out.push("queued");
		for (const fn of queue.splice(0)) fn();
		return out;
	};
	const theirs = run(mobx);
	expect(theirs).toEqual(["queued", true, 2, "queued", 3]);
	expect(run(sobx)).toEqual(theirs);
});
