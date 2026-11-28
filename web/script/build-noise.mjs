import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../", import.meta.url));
const out = fileURLToPath(new URL("../../.tools/web-codec/", import.meta.url));
mkdirSync(out, { recursive: true });
copyFileSync(`${web}noise-entropy.mjs`, `${out}noise-entropy.mjs`);
execFileSync(
	"cargo",
	[
		"build",
		"--locked",
		"--release",
		"--manifest-path",
		"noise-codec/Cargo.toml",
		"--target",
		"wasm32-unknown-unknown",
		"--target-dir",
		out,
	],
	{
		cwd: web,
		stdio: "inherit",
		env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="custom"' },
	},
);
// Convert at build time: the browser gets static JS and never evaluates code or compiles WASM.
execFileSync(
	process.execPath,
	[
		"node_modules/binaryen/bin/wasm2js",
		`${out}wasm32-unknown-unknown/release/rothcold_web_noise.wasm`,
		"--all-features",
		"--pedantic",
		"-O2",
		"-o",
		`${out}noise-codec.mjs`,
	],
	{ cwd: web, stdio: "inherit" },
);
