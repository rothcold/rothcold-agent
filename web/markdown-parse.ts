export type Inline =
	| { type: "text"; text: string }
	| { type: "code"; text: string }
	| { type: "strong"; children: Inline[] }
	| { type: "em"; children: Inline[] }
	| { type: "del"; children: Inline[] }
	| { type: "link"; href: string; children: Inline[] }
	| { type: "br" };

export type ListItem = {
	checked?: boolean;
	children: Block[];
};

export type Block =
	| { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
	| { type: "paragraph"; inlines: Inline[] }
	| { type: "code"; lang: string; text: string }
	| { type: "blockquote"; blocks: Block[] }
	| { type: "list"; ordered: boolean; start: number; items: ListItem[] }
	| { type: "table"; headers: Inline[][]; rows: Inline[][][] }
	| { type: "hr" };

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const HR_RE = /^ {0,3}(?:(\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>/;
const TASK_RE = /^\[( |x|X)\]\s+(.*)$/;

function safeHref(raw: string): string | null {
	const trimmed = raw.trim();
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return parsed.href;
		}
	} catch {
		return null;
	}
	return null;
}

function splitTableRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && i + 1 < s.length && s[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (s[i] === "|") {
			cells.push(cur.trim());
			cur = "";
		} else {
			cur += s[i];
		}
	}
	cells.push(cur.trim());
	return cells;
}

function isTableStart(lines: string[], idx: number): boolean {
	if (idx + 1 >= lines.length) return false;
	return lines[idx].includes("|") && TABLE_SEP_RE.test(lines[idx + 1]);
}

function isBlockStarter(lines: string[], idx: number): boolean {
	const line = lines[idx];
	return (
		FENCE_RE.test(line) ||
		HEADING_RE.test(line) ||
		HR_RE.test(line) ||
		QUOTE_RE.test(line) ||
		UL_RE.test(line) ||
		OL_RE.test(line) ||
		isTableStart(lines, idx)
	);
}

type ParsedBlock = { block: Block; next: number };

function parseCodeBlock(
	lines: string[],
	start: number,
	open: RegExpExecArray,
): ParsedBlock {
	const fence = open[1];
	const marker = fence[0];
	const lang = open[2].trim().split(/\s+/)[0];
	const body: string[] = [];
	let next = start + 1;
	for (; next < lines.length; next++) {
		const close = /^ {0,3}(`{3,}|~{3,})$/.exec(lines[next].trimEnd());
		if (close && close[1][0] === marker && close[1].length >= fence.length) {
			next++;
			break;
		}
		body.push(lines[next]);
	}
	return { block: { type: "code", lang, text: body.join("\n") }, next };
}

function indentation(line: string) {
	return line.match(/^\s*/)?.[0].length ?? 0;
}

function listItemLines(
	lines: string[],
	start: number,
	indent: number,
	first: string,
) {
	const content = [first];
	let next = start + 1;
	for (; next < lines.length; next++) {
		const line = lines[next];
		if (!line.trim()) {
			const peek = lines[next + 1];
			if (!peek || indentation(peek) <= indent) break;
			content.push("");
			continue;
		}
		const innerIndent = indentation(line);
		if (innerIndent > indent) {
			content.push(line.slice(Math.min(innerIndent, indent + 2)));
			continue;
		}
		if (isBlockStarter(lines, next)) break;
		content.push(line.trim());
	}
	return { content, next };
}

function parseList(
	lines: string[],
	start: number,
	marker: RegExpExecArray,
	ordered: boolean,
): ParsedBlock {
	const baseIndent = marker[1].length;
	const startNum = ordered ? Number.parseInt(marker[2], 10) : 1;
	const pattern = ordered ? OL_RE : UL_RE;
	const items: ListItem[] = [];
	let next = start;
	for (let match = marker; next < lines.length; ) {
		const task = ordered ? null : TASK_RE.exec(match[3]);
		const item = listItemLines(lines, next, baseIndent, task?.[2] ?? match[3]);
		const children = parseBlocks(item.content.join("\n"));
		items.push(
			task
				? { checked: task[1].toLowerCase() === "x", children }
				: { children },
		);
		next = item.next;
		if (next === lines.length) break;
		const marker = pattern.exec(lines[next]);
		if (!marker || marker[1].length !== baseIndent) break;
		match = marker;
	}
	return { block: { type: "list", ordered, start: startNum, items }, next };
}

function parseQuote(lines: string[], start: number): ParsedBlock {
	const quoted: string[] = [];
	let next = start;
	for (; next < lines.length && QUOTE_RE.test(lines[next]); next++) {
		quoted.push(lines[next].replace(/^ {0,3}>\s?/, ""));
	}
	return {
		block: { type: "blockquote", blocks: parseBlocks(quoted.join("\n")) },
		next,
	};
}

function parseTable(lines: string[], start: number): ParsedBlock {
	const headers = splitTableRow(lines[start]).map((cell) => parseInline(cell));
	const rows: Inline[][][] = [];
	let next = start + 2;
	for (; next < lines.length; next++) {
		const line = lines[next];
		if (!line.trim() || !line.includes("|") || FENCE_RE.test(line)) break;
		const cells = splitTableRow(line);
		rows.push(headers.map((_, index) => parseInline(cells[index] ?? "")));
	}
	return { block: { type: "table", headers, rows }, next };
}

function parseParagraph(lines: string[], start: number): ParsedBlock {
	let next = start + 1;
	for (; next < lines.length && lines[next].trim(); next++) {
		if (isBlockStarter(lines, next)) break;
	}
	return {
		block: {
			type: "paragraph",
			inlines: parseInlineLines(lines.slice(start, next)),
		},
		next,
	};
}

function parseBlock(lines: string[], start: number): ParsedBlock {
	const line = lines[start];
	const fence = FENCE_RE.exec(line);
	if (fence) return parseCodeBlock(lines, start, fence);
	const heading = HEADING_RE.exec(line);
	if (heading) {
		const level = heading[1].length as Extract<
			Block,
			{ type: "heading" }
		>["level"];
		return {
			block: { type: "heading", level, inlines: parseInline(heading[2]) },
			next: start + 1,
		};
	}
	if (HR_RE.test(line)) return { block: { type: "hr" }, next: start + 1 };
	if (QUOTE_RE.test(line)) return parseQuote(lines, start);
	if (isTableStart(lines, start)) return parseTable(lines, start);
	const unordered = UL_RE.exec(line);
	if (unordered) return parseList(lines, start, unordered, false);
	const ordered = OL_RE.exec(line);
	if (ordered) return parseList(lines, start, ordered, true);
	return parseParagraph(lines, start);
}

export function parseBlocks(source: string): Block[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	for (let index = 0; index < lines.length; ) {
		if (!lines[index].trim()) {
			index++;
			continue;
		}
		const { block, next } = parseBlock(lines, index);
		blocks.push(block);
		index = next;
	}
	return blocks;
}

function parseInlineLines(lines: string[]): Inline[] {
	const out: Inline[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) out.push({ type: "br" });
		out.push(...parseInline(lines[i]));
	}
	return out;
}

function pushText(out: Inline[], text: string) {
	if (!text) return;
	const prev = out[out.length - 1];
	if (prev?.type === "text") {
		prev.text += text;
	} else {
		out.push({ type: "text", text });
	}
}

function findClose(src: string, from: number, delim: string): number {
	for (let index = from; index < src.length; ) {
		const hit = src.indexOf(delim, index);
		if (hit === -1) return -1;
		if (hit > from && src[hit - 1] !== "\\") return hit;
		index = hit + delim.length;
	}
	return -1;
}

type Span = { node: Inline; next: number };

function parseCodeSpan(src: string, start: number): Span | undefined {
	let openEnd = start + 1;
	while (src[openEnd] === "`") openEnd++;
	const delimiter = src.slice(start, openEnd);
	const end = src.indexOf(delimiter, openEnd);
	if (end === -1) return;
	let text = src.slice(openEnd, end);
	if (
		text.length >= 2 &&
		text.startsWith(" ") &&
		text.endsWith(" ") &&
		text.trim()
	) {
		text = text.slice(1, -1);
	}
	return { node: { type: "code", text }, next: end + delimiter.length };
}

function parseLink(src: string, start: number): Span | undefined {
	const closeBracket = src.indexOf("]", start + 1);
	if (closeBracket === -1 || src[closeBracket + 1] !== "(") return;
	const closeParen = src.indexOf(")", closeBracket + 2);
	if (closeParen === -1) return;
	const href = safeHref(src.slice(closeBracket + 2, closeParen));
	if (!href) return;
	const children = parseInline(src.slice(start + 1, closeBracket));
	return { node: { type: "link", href, children }, next: closeParen + 1 };
}

function parseEmphasis(
	src: string,
	start: number,
	delimiter: string,
	type: "strong" | "del" | "em",
): Span | undefined {
	const from = start + delimiter.length;
	const end = findClose(src, from, delimiter);
	if (end === -1 || (type === "em" && src[end - 1] === " ")) return;
	const content = src.slice(from, end);
	if (!content.trim()) return;
	return {
		node: { type, children: parseInline(content) },
		next: end + delimiter.length,
	};
}

function parseSpan(src: string, start: number): Span | undefined {
	const ch = src[start];
	if (ch === "`") return parseCodeSpan(src, start);
	if (ch === "[") return parseLink(src, start);
	const following = src[start + 1];
	if (ch === following) {
		if (ch === "*" || ch === "_")
			return parseEmphasis(src, start, ch + ch, "strong");
		if (ch === "~") return parseEmphasis(src, start, "~~", "del");
		return;
	}
	if (ch === "*" && following !== " ")
		return parseEmphasis(src, start, "*", "em");
}

export function parseInline(src: string): Inline[] {
	const out: Inline[] = [];
	for (let index = 0; index < src.length; ) {
		const ch = src[index];
		if (
			ch === "\\" &&
			index + 1 < src.length &&
			/[\\`*_{}[\]()#+\-.!~|]/.test(src[index + 1])
		) {
			pushText(out, src[index + 1]);
			index += 2;
			continue;
		}
		const span = parseSpan(src, index);
		if (span) {
			out.push(span.node);
			index = span.next;
		} else {
			pushText(out, ch);
			index++;
		}
	}
	return out;
}
