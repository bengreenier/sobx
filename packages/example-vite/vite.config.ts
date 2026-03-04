import { sobxCompiler } from "@sobx/compiler/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [sobxCompiler()],
});
