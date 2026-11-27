import assert from "node:assert/strict";
import test from "node:test";
import { parseBlocks, parseInline } from "./markdown-parse.ts";

test("renders headings, lists, code fences, tables, and blockquotes", () => {
	const md = [
		"# Summary",
		"",
		"Paragraph with **bold**, *italic*, ~~strike~~, and `inline_code`.",
		"",
		"```rust",
		'fn main() { println!("hi"); }',
		"```",
		"",
		"| Name | Status |",
		"| --- | --- |",
		"| build | ok |",
		"",
		"- [x] done",
		"- [ ] next",
		"",
		"> quoted note",
	].join("\n");
	const blocks = parseBlocks(md);
	assert.deepEqual(
		blocks.map((b) => b.type),
		["heading", "paragraph", "code", "table", "list", "blockquote"],
	);
	assert.equal(blocks[0].type, "heading");
	assert.equal(blocks[2].type === "code" && blocks[2].lang, "rust");
	assert.equal(blocks[3].type === "table" && blocks[3].rows.length, 1);
	assert.equal(blocks[4].type === "list" && blocks[4].items[0].checked, true);
	assert.equal(blocks[4].type === "list" && blocks[4].items[1].checked, false);
});

test("keeps raw angle brackets literal and blocks unsafe link schemes", () => {
	const literal = parseInline("Start with <chapter one>.");
	assert.deepEqual(literal, [
		{ type: "text", text: "Start with <chapter one>." },
	]);

	const unsafe = parseInline("[click](javascript:alert(1))");
	assert.equal(
		unsafe.some((n) => n.type === "link"),
		false,
	);

	const safe = parseInline("[docs](https://example.com/a)");
	assert.deepEqual(safe, [
		{
			type: "link",
			href: "https://example.com/a",
			children: [{ type: "text", text: "docs" }],
		},
	]);
});

test("continues past nested list lines and matching code fences", () => {
	const blocks = parseBlocks(
		[
			"3. first",
			"   - [x] nested",
			"4. second",
			"",
			"> quoted",
			"> next line",
			"",
			"~~~~ ts",
			"~~~",
			"~~~~",
			"after",
		].join("\n"),
	);
	assert.deepEqual(blocks, [
		{
			type: "list",
			ordered: true,
			start: 3,
			items: [
				{
					children: [
						{ type: "paragraph", inlines: [{ type: "text", text: "first" }] },
						{
							type: "list",
							ordered: false,
							start: 1,
							items: [
								{
									checked: true,
									children: [
										{
											type: "paragraph",
											inlines: [{ type: "text", text: "nested" }],
										},
									],
								},
							],
						},
					],
				},
				{
					children: [
						{ type: "paragraph", inlines: [{ type: "text", text: "second" }] },
					],
				},
			],
		},
		{
			type: "blockquote",
			blocks: [
				{
					type: "paragraph",
					inlines: [
						{ type: "text", text: "quoted" },
						{ type: "br" },
						{ type: "text", text: "next line" },
					],
				},
			],
		},
		{ type: "code", lang: "ts", text: "~~~" },
		{ type: "paragraph", inlines: [{ type: "text", text: "after" }] },
	]);
});
