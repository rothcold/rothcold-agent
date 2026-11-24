import { Fragment, type ReactNode } from "react";
import { type Block, type Inline, parseBlocks } from "./markdown-parse";

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

function renderBlocks(blocks: Block[], prefix: string): ReactNode {
	const out: ReactNode[] = [];
	for (let idx = 0; idx < blocks.length; idx++) {
		const block = blocks[idx];
		const key = `${prefix}-${idx}`;
		switch (block.type) {
			case "heading":
				out.push(
					renderHeading(block.level, renderInlines(block.inlines, key), key),
				);
				break;
			case "paragraph":
				out.push(<p key={key}>{renderInlines(block.inlines, key)}</p>);
				break;
			case "code":
				out.push(
					<div key={key} className="code-block">
						{block.lang && <div className="code-lang">{block.lang}</div>}
						<pre>
							<code>{block.text}</code>
						</pre>
					</div>,
				);
				break;
			case "blockquote":
				out.push(
					<blockquote key={key}>{renderBlocks(block.blocks, key)}</blockquote>,
				);
				break;
			case "list": {
				const items: ReactNode[] = [];
				for (let j = 0; j < block.items.length; j++) {
					const item = block.items[j];
					const itemKey = `${key}-i${j}`;
					const singlePara =
						item.children.length === 1 && item.children[0].type === "paragraph"
							? renderInlines(item.children[0].inlines, itemKey)
							: renderBlocks(item.children, itemKey);
					items.push(
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
							<span>{singlePara}</span>
						</li>,
					);
				}
				out.push(
					block.ordered ? (
						<ol key={key} start={block.start}>
							{items}
						</ol>
					) : (
						<ul key={key}>{items}</ul>
					),
				);
				break;
			}
			case "table": {
				const heads: ReactNode[] = [];
				for (let c = 0; c < block.headers.length; c++) {
					const ck = `${key}-h${c}`;
					heads.push(<th key={ck}>{renderInlines(block.headers[c], ck)}</th>);
				}
				const bodyRows: ReactNode[] = [];
				for (let r = 0; r < block.rows.length; r++) {
					const row = block.rows[r];
					const cells: ReactNode[] = [];
					for (let c = 0; c < row.length; c++) {
						const ck = `${key}-r${r}c${c}`;
						cells.push(<td key={ck}>{renderInlines(row[c], ck)}</td>);
					}
					bodyRows.push(<tr key={`${key}-r${r}`}>{cells}</tr>);
				}
				out.push(
					<div key={key} className="table-wrap">
						<table>
							<thead>
								<tr>{heads}</tr>
							</thead>
							<tbody>{bodyRows}</tbody>
						</table>
					</div>,
				);
				break;
			}
			case "hr":
				out.push(<hr key={key} />);
				break;
		}
	}
	return out;
}

export function Markdown({ text }: { text: string }) {
	const blocks = parseBlocks(text);
	return <div className="markdown">{renderBlocks(blocks, "md")}</div>;
}
