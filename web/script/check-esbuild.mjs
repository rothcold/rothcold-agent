import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const project = createRequire(import.meta.url);
const vite = createRequire(project.resolve("vite/package.json"));
const esbuild = createRequire(vite.resolve("esbuild/package.json"));
const pkg = esbuild("./package.json");
const platform = `@esbuild/${process.platform}-${process.arch}`;
assert.equal(process.env.ESBUILD_BINARY_PATH, undefined);
assert.equal(pkg.optionalDependencies[platform], pkg.version);
assert.equal(esbuild(`${platform}/package.json`).version, pkg.version);
const binary = esbuild.resolve(
	`${platform}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`,
);
assert.equal(
	execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
	pkg.version,
);
process.stdout.write(`Verified Vite's ${platform} ${pkg.version}\n`);
