import { defineConfig } from "vite";
export default defineConfig({
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
