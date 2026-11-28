import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const { packages } = JSON.parse(
	execFileSync(
		"cargo",
		[
			"metadata",
			"--locked",
			"--format-version=1",
			"--filter-platform",
			"wasm32-unknown-unknown",
			"--manifest-path",
			"noise-codec/Cargo.toml",
		],
		{ maxBuffer: 8 * 1024 * 1024 },
	),
);
const notices = ["\n## Browser Noise codec (transpiled Rust dependencies)\n"];
for (const pkg of packages
	.filter(({ source }) => source)
	.sort((a, b) => a.name.localeCompare(b.name))) {
	const root = dirname(pkg.manifest_path);
	const paths = new Set(
		readdirSync(root, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isFile() &&
					/^(?:licen[cs]e|notice|copyright|copying)(?:[._-]|$)/i.test(
						entry.name,
					),
			)
			.map((entry) => entry.name),
	);
	if (pkg.license_file) paths.add(pkg.license_file);
	if (!pkg.license && !paths.size)
		throw new Error(`No license metadata for ${pkg.name}`);
	notices.push(
		`\n### ${pkg.name} ${pkg.version} — ${pkg.license ?? "see license below"}\n`,
	);
	for (const name of Array.from(paths).sort()) {
		notices.push(`\n${name}\n\n${readFileSync(join(root, name), "utf8")}\n`);
	}
}
notices.push(
	"\n### Binaryen (wasm2js build tool)\n\n",
	readFileSync("node_modules/binaryen/LICENSE", "utf8"),
);
appendFileSync("dist/licenses.md", notices.join(""));
