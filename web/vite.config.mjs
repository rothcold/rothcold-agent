import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
const path = (name) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
	resolve: {
		alias: {
			"#noise-codec": path("../.tools/web-codec/noise-codec.mjs"),
		},
	},
	esbuild: { jsx: "automatic" },
	build: {
		outDir: "dist",
		emptyOutDir: true,
		modulePreload: false,
		license: { fileName: "licenses.md" },
		rollupOptions: {
			output: { entryFileNames: "app.js", assetFileNames: "app[extname]" },
		},
	},
});
