import { defineConfig } from "vite";
import { sobxCompiler } from "@sobx/compiler/vite";

export default defineConfig({
	plugins: [sobxCompiler()],
});
