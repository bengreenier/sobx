import { version } from "react";

it("runs against the React version of its project", () => {
	expect(version.split(".")[0]).toBe(process.env.REACT_MAJOR);
});
