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
		/^ {0,3}>/.test(line) ||
		UL_RE.test(line) ||
		OL_RE.test(line) ||
		isTableStart(lines, idx)
	);
}

function parseCodeBlock(
	lines: string[],
	start: number,
): { block: Block; next: number } {
	const open = FENCE_RE.exec(lines[start]);
	const fence = open?.[1] ?? "```";
	const marker = fence[0];
	const lang = (open?.[2] ?? "").trim().split(/\s+/)[0] ?? "";
	const body: string[] = [];
	let i = start + 1;
	while (i < lines.length) {
		const trimmed = lines[i].trimEnd();
		const closeMatch = /^ {0,3}(`{3,}|~{3,})$/.exec(trimmed);
		if (
			closeMatch &&
			closeMatch[1][0] === marker &&
			closeMatch[1].length >= fence.length
		) {
			i++;
			break;
		}
		body.push(lines[i]);
		i++;
	}
	return {
		block: { type: "code", lang, text: body.join("\n") },
		next: i,
	};
}

function parseList(
	lines: string[],
	start: number,
): { block: Block; next: number } {
	const firstUl = UL_RE.exec(lines[start]);
	const firstOl = OL_RE.exec(lines[start]);
	const ordered = !firstUl && Boolean(firstOl);
	const baseIndent = (firstUl?.[1] ?? firstOl?.[1] ?? "").length;
	const startNum = ordered ? Number.parseInt(firstOl?.[2] ?? "1", 10) : 1;
	const items: ListItem[] = [];
	let i = start;

	while (i < lines.length) {
		const match = ordered ? OL_RE.exec(lines[i]) : UL_RE.exec(lines[i]);
		if (!match || match[1].length !== baseIndent) break;
		let rawContent = match[3];
		let checked: boolean | undefined;
		if (!ordered) {
			const task = TASK_RE.exec(rawContent);
			if (task) {
				checked = task[1].toLowerCase() === "x";
				rawContent = task[2];
			}
		}
		const itemLines = [rawContent];
		i++;
		while (i < lines.length) {
			const cur = lines[i];
			if (!cur.trim()) {
				const peek = lines[i + 1];
				if (
					peek &&
					/^\s+/.test(peek) &&
					(peek.match(/^\s*/)?.[0].length ?? 0) > baseIndent
				) {
					itemLines.push("");
					i++;
					continue;
				}
				break;
			}
			const indent = cur.match(/^\s*/)?.[0].length ?? 0;
			if (indent > baseIndent) {
				itemLines.push(cur.slice(Math.min(indent, baseIndent + 2)));
				i++;
				continue;
			}
			if (isBlockStarter(lines, i)) break;
			itemLines.push(cur.trim());
			i++;
		}
		const children = parseBlocks(itemLines.join("\n"));
		items.push(checked === undefined ? { children } : { checked, children });
	}
	return { block: { type: "list", ordered, start: startNum, items }, next: i };
}

export function parseBlocks(source: string): Block[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		if (FENCE_RE.test(line)) {
			const res = parseCodeBlock(lines, i);
			blocks.push(res.block);
			i = res.next;
			continue;
		}
		const heading = HEADING_RE.exec(line);
		if (heading) {
			const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
			blocks.push({ type: "heading", level, inlines: parseInline(heading[2]) });
			i++;
			continue;
		}
		if (HR_RE.test(line)) {
			blocks.push({ type: "hr" });
			i++;
			continue;
		}
		if (/^ {0,3}>/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
				quoted.push(lines[i].replace(/^ {0,3}>\s?/, ""));
				i++;
			}
			blocks.push({
				type: "blockquote",
				blocks: parseBlocks(quoted.join("\n")),
			});
			continue;
		}
		if (isTableStart(lines, i)) {
			const headers = splitTableRow(lines[i]).map((c) => parseInline(c));
			i += 2;
			const rows: Inline[][][] = [];
			while (
				i < lines.length &&
				lines[i].trim() &&
				lines[i].includes("|") &&
				!FENCE_RE.test(lines[i])
			) {
				const cells = splitTableRow(lines[i]);
				while (cells.length < headers.length) cells.push("");
				rows.push(cells.slice(0, headers.length).map((c) => parseInline(c)));
				i++;
			}
			blocks.push({ type: "table", headers, rows });
			continue;
		}
		if (UL_RE.test(line) || OL_RE.test(line)) {
			const res = parseList(lines, i);
			blocks.push(res.block);
			i = res.next;
			continue;
		}
		const para: string[] = [line];
		i++;
		while (i < lines.length && lines[i].trim() && !isBlockStarter(lines, i)) {
			para.push(lines[i]);
			i++;
		}
		blocks.push({ type: "paragraph", inlines: parseInlineLines(para) });
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
	let idx = from;
	while (idx < src.length) {
		const hit = src.indexOf(delim, idx);
		if (hit === -1) return -1;
		if (hit > from && src[hit - 1] !== "\\") return hit;
		idx = hit + delim.length;
	}
	return -1;
}

export function parseInline(src: string): Inline[] {
	const out: Inline[] = [];
	let i = 0;

	while (i < src.length) {
		const ch = src[i];
		if (
			ch === "\\" &&
			i + 1 < src.length &&
			/[\\`*_{}[\]()#+\-.!~|]/.test(src[i + 1])
		) {
			pushText(out, src[i + 1]);
			i += 2;
			continue;
		}
		if (ch === "`") {
			let ticks = 1;
			while (src[i + ticks] === "`") ticks++;
			const delim = "`".repeat(ticks);
			const end = src.indexOf(delim, i + ticks);
			if (end !== -1) {
				let content = src.slice(i + ticks, end);
				if (
					content.length >= 2 &&
					content.startsWith(" ") &&
					content.endsWith(" ") &&
					content.trim().length > 0
				) {
					content = content.slice(1, -1);
				}
				out.push({ type: "code", text: content });
				i = end + ticks;
				continue;
			}
		}
		if (ch === "[") {
			const closeBracket = src.indexOf("]", i + 1);
			if (closeBracket !== -1 && src[closeBracket + 1] === "(") {
				const closeParen = src.indexOf(")", closeBracket + 2);
				if (closeParen !== -1) {
					const label = src.slice(i + 1, closeBracket);
					const href = safeHref(src.slice(closeBracket + 2, closeParen));
					if (href) {
						out.push({ type: "link", href, children: parseInline(label) });
						i = closeParen + 1;
						continue;
					}
				}
			}
		}
		if (
			(ch === "*" && src[i + 1] === "*") ||
			(ch === "_" && src[i + 1] === "_")
		) {
			const delim = ch + ch;
			const end = findClose(src, i + 2, delim);
			if (end !== -1 && src.slice(i + 2, end).trim()) {
				out.push({
					type: "strong",
					children: parseInline(src.slice(i + 2, end)),
				});
				i = end + 2;
				continue;
			}
		}
		if (ch === "~" && src[i + 1] === "~") {
			const end = findClose(src, i + 2, "~~");
			if (end !== -1 && src.slice(i + 2, end).trim()) {
				out.push({ type: "del", children: parseInline(src.slice(i + 2, end)) });
				i = end + 2;
				continue;
			}
		}
		if (ch === "*" && src[i + 1] !== "*" && src[i + 1] !== " ") {
			const end = findClose(src, i + 1, "*");
			if (end !== -1 && src[end - 1] !== " " && src.slice(i + 1, end).trim()) {
				out.push({ type: "em", children: parseInline(src.slice(i + 1, end)) });
				i = end + 1;
				continue;
			}
		}
		pushText(out, ch);
		i++;
	}
	return out;
}
