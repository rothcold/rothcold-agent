import { Fragment, type ReactNode } from "react";
import {
	type Block,
	type Inline,
	type ListItem,
	parseBlocks,
} from "./markdown-parse.ts";

function unknownMarkdownNode(node: never): never {
	throw new Error(`Unknown Markdown node: ${JSON.stringify(node)}`);
}

function renderInlines(nodes: Inline[], prefix: string): ReactNode {
	const out: ReactNode[] = [];
	for (let idx = 0; idx < nodes.length; idx++) {
		const node = nodes[idx];
		const key = `${prefix}-${idx}`;
		switch (node.type) {
			case "text":
				out.push(<Fragment key={key}>{node.text}</Fragment>);
				break;
			case "code":
				out.push(<code key={key}>{node.text}</code>);
				break;
			case "strong":
				out.push(
					<strong key={key}>{renderInlines(node.children, key)}</strong>,
				);
				break;
			case "em":
				out.push(<em key={key}>{renderInlines(node.children, key)}</em>);
				break;
			case "del":
				out.push(<del key={key}>{renderInlines(node.children, key)}</del>);
				break;
			case "link":
				out.push(
					<a
						key={key}
						href={node.href}
						target="_blank"
						rel="noopener noreferrer"
					>
						{renderInlines(node.children, key)}
					</a>,
				);
				break;
			case "br":
				out.push(<br key={key} />);
				break;
			default:
				return unknownMarkdownNode(node);
		}
	}
	return out;
}

function renderHeading(
	level: 1 | 2 | 3 | 4 | 5 | 6,
	children: ReactNode,
	key: string,
) {
	// Shift # headings down one level so they stay below the thread's <h1> title.
	switch (level) {
		case 1:
			return <h2 key={key}>{children}</h2>;
		case 2:
			return <h3 key={key}>{children}</h3>;
		case 3:
			return <h4 key={key}>{children}</h4>;
		case 4:
			return <h5 key={key}>{children}</h5>;
		default:
			return <h6 key={key}>{children}</h6>;
	}
}

function renderListItem(item: ListItem, itemKey: string) {
	const onlyChild = item.children.length === 1 ? item.children[0] : undefined;
	const content =
		onlyChild?.type === "paragraph"
			? renderInlines(onlyChild.inlines, itemKey)
			: renderBlocks(item.children, itemKey);
	return (
		<li
			key={itemKey}
			className={item.checked === undefined ? undefined : "task-item"}
		>
			{item.checked !== undefined && (
				<input
					type="checkbox"
					checked={item.checked}
					readOnly
					aria-label={item.checked ? "Completed" : "Pending"}
				/>
			)}
			<span>{content}</span>
		</li>
	);
}

function renderList(block: Extract<Block, { type: "list" }>, key: string) {
	const items = block.items.map((item, index) =>
		renderListItem(item, `${key}-i${index}`),
	);
	return block.ordered ? (
		<ol key={key} start={block.start}>
			{items}
		</ol>
	) : (
		<ul key={key}>{items}</ul>
	);
}

function renderTable(block: Extract<Block, { type: "table" }>, key: string) {
	const heads = block.headers.map((cell, index) => {
		const cellKey = `${key}-h${index}`;
		return <th key={cellKey}>{renderInlines(cell, cellKey)}</th>;
	});
	const bodyRows: ReactNode[] = [];
	for (const [rowIndex, row] of block.rows.entries()) {
		const rowKey = `${key}-r${rowIndex}`;
		const cells = row.map((cell, colIndex) => {
			const cellKey = `${rowKey}c${colIndex}`;
			return <td key={cellKey}>{renderInlines(cell, cellKey)}</td>;
		});
		bodyRows.push(<tr key={rowKey}>{cells}</tr>);
	}
	return (
		<div key={key} className="table-wrap">
			<table>
				<thead>
					<tr>{heads}</tr>
				</thead>
				<tbody>{bodyRows}</tbody>
			</table>
		</div>
	);
}

function renderBlock(block: Block, key: string): ReactNode {
	switch (block.type) {
		case "heading":
			return renderHeading(block.level, renderInlines(block.inlines, key), key);
		case "paragraph":
			return <p key={key}>{renderInlines(block.inlines, key)}</p>;
		case "code":
			return (
				<div key={key} className="code-block">
					{block.lang && <div className="code-lang">{block.lang}</div>}
					<pre>
						<code>{block.text}</code>
					</pre>
				</div>
			);
		case "blockquote":
			return (
				<blockquote key={key}>{renderBlocks(block.blocks, key)}</blockquote>
			);
		case "list":
			return renderList(block, key);
		case "table":
			return renderTable(block, key);
		case "hr":
			return <hr key={key} />;
		default:
			return unknownMarkdownNode(block);
	}
}

function renderBlocks(blocks: Block[], prefix: string): ReactNode {
	return blocks.map((block, index) => renderBlock(block, `${prefix}-${index}`));
}

export function Markdown({ text }: { text: string }) {
	const blocks = parseBlocks(text);
	return <div className="markdown">{renderBlocks(blocks, "md")}</div>;
}
