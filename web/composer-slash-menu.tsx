import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { WorkspaceClient } from "./noise-workspace.ts";

type SlashCatalog = { commands: string[]; skills: string[] };
type CatalogState = { server: WorkspaceClient; catalog: SlashCatalog | null };
const groups = [
	{ key: "commands", label: "Commands" },
	{ key: "skills", label: "Skills" },
] as const;

function isEmptyParagraph(doc: ProseMirrorNode) {
	return (
		doc.childCount === 1 &&
		doc.firstChild?.type.name === "paragraph" &&
		doc.firstChild.childCount === 0
	);
}

function queryAtCursor({ doc, selection, storedMarks }: EditorState) {
	const paragraph = doc.firstChild;
	const text = paragraph?.firstChild;
	return doc.childCount === 1 &&
		paragraph?.type.name === "paragraph" &&
		paragraph.childCount === 1 &&
		text?.isText &&
		!text.marks.length &&
		!storedMarks?.length &&
		selection.empty &&
		selection.from === paragraph.content.size + 1 &&
		/^\/[\da-z_-]*$/i.test(text.text ?? "")
		? (text.text ?? "").slice(1).toLowerCase()
		: null;
}

function catalogNames(value: unknown, limit: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= limit &&
		value.every(
			(item) => typeof item === "string" && /^[a-z0-9_-]{1,64}$/.test(item),
		)
	);
}

function useSlashCatalog(server: WorkspaceClient, open: boolean) {
	const [value, setValue] = useState<CatalogState | null>(null);
	useLayoutEffect(() => {
		setValue(null);
		if (!open) return;
		let current = true;
		let timer: ReturnType<typeof setTimeout>;
		async function refresh() {
			const response = await server.call("slash_catalog", {}).catch(() => null);
			const data = response?.catalog;
			if (!current) return;
			const catalog =
				catalogNames(data?.commands, 128) && catalogNames(data?.skills, 256)
					? data
					: null;
			setValue({ server, catalog });
			timer = setTimeout(refresh, 5000);
		}
		void refresh();
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [open, server]);
	return value?.server === server ? value.catalog : undefined;
}

type ApprovalSuggestion = (choice: "once" | "deny") => boolean;

function slashMatches(
	catalog: SlashCatalog | null | undefined,
	query: string | null,
	canSuggestApproval?: ApprovalSuggestion,
) {
	if (!catalog || query === null) return [];
	const matches = groups.map(({ key, label }) => ({
		label,
		names: catalog[key].filter((name) => {
			if (!name.startsWith(query)) return false;
			if (name === "approve" || name === "deny")
				return Boolean(
					canSuggestApproval?.(name === "approve" ? "once" : "deny"),
				);
			return true;
		}),
	}));
	// Promote an exact match ahead of prefixes without separating it from its group.
	const groupIndex = matches.findIndex(({ names }) => names.includes(query));
	if (groupIndex >= 0) {
		const [exact] = matches.splice(groupIndex, 1);
		exact.names.splice(exact.names.indexOf(query), 1);
		exact.names.unshift(query);
		matches.unshift(exact);
	}
	return matches;
}

export function useComposerSlashMenu(
	id: string,
	server: WorkspaceClient,
	blocked: boolean,
	canSuggestApproval?: ApprovalSuggestion,
) {
	const [query, setQuery] = useState<string | null>(null);
	const activeQuery = useRef<string | null>(null);
	const [highlighted, setHighlighted] = useState<string | null>(null);
	const composing = useRef(false);
	const open = query !== null && !blocked;
	const catalog = useSlashCatalog(server, open);
	const menuId = `${id}-slash-options`;
	const listRef = useRef<HTMLDivElement>(null);
	const matches = slashMatches(catalog, query, canSuggestApproval);
	const names = matches.flatMap((group) => group.names);
	const selected = names.length
		? Math.max(0, names.indexOf(highlighted ?? ""))
		: -1;
	const activeId = selected >= 0 ? `${menuId}-${selected}` : undefined;

	const change = useCallback((next: string | null) => {
		if (next === activeQuery.current) return;
		activeQuery.current = next;
		setQuery(next);
		setHighlighted(null);
	}, []);

	function select(editor: Editor | null, name: string) {
		if (!editor?.isEditable || editor.view.composing || composing.current)
			return;
		const query = activeQuery.current;
		if (
			query === null ||
			query !== queryAtCursor(editor.state) ||
			!name.startsWith(query)
		)
			return;
		change(null);
		editor
			.chain()
			.focus()
			.insertContentAt({ from: 1, to: editor.state.selection.from }, `/${name}`)
			.run();
	}

	function onTransaction(editor: Editor, transaction: Transaction) {
		if (
			!editor.isEditable ||
			composing.current ||
			transaction.getMeta("composition") !== undefined
		) {
			change(null);
			return;
		}
		const next = queryAtCursor(editor.state);
		if (activeQuery.current !== null) change(next);
		else if (
			next === "" &&
			transaction.docChanged &&
			!transaction.getMeta("paste") &&
			!transaction.getMeta("uiEvent") &&
			isEmptyParagraph(transaction.before)
		)
			change(next);
	}

	function onKeyDown(editor: Editor | null, event: KeyboardEvent) {
		if (
			activeQuery.current === null ||
			!editor?.isEditable ||
			composing.current ||
			editor.view.composing
		)
			return false;
		if (event.key === "Escape") {
			event.preventDefault();
			change(null);
			return true;
		}
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
			return false;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const offset = event.key === "ArrowDown" ? 1 : -1;
			if (selected >= 0)
				setHighlighted(
					names[(selected + offset + names.length) % names.length],
				);
			return true;
		}
		if (event.key !== "Enter") return false;
		event.preventDefault();
		if (activeQuery.current === query && selected >= 0)
			select(editor, names[selected]);
		return true;
	}

	useLayoutEffect(() => {
		if (blocked) change(null);
	}, [blocked, change]);
	useLayoutEffect(() => {
		if (activeId)
			listRef.current
				?.querySelector('[aria-selected="true"]')
				?.scrollIntoView({ block: "nearest" });
	}, [activeId]);

	return {
		editorAttributes: open
			? {
					"aria-controls": menuId,
					"aria-autocomplete": "list",
					...(activeId && { "aria-activedescendant": activeId }),
				}
			: {},
		onTransaction,
		onKeyDown,
		isComposing: () => composing.current,
		close: () => change(null),
		startComposition() {
			composing.current = true;
			change(null);
			return false;
		},
		endComposition() {
			composing.current = false;
			return false;
		},
		render(editor: Editor | null) {
			if (!open) return null;
			return (
				<div className="composer-slash-menu">
					{names.length === 0 && (
						<p role="status">
							{catalog === undefined
								? "Loading Gateway suggestions…"
								: catalog === null
									? "Gateway suggestions unavailable. You can still type commands manually."
									: "No matching commands or skills."}
						</p>
					)}
					<div
						id={menuId}
						role="listbox"
						aria-label="Gateway suggestions"
						ref={listRef}
						hidden={!names.length}
					>
						{matches.map(
							({ label, names: entries }) =>
								entries.length > 0 && (
									<fieldset key={label}>
										<legend>{label}</legend>
										{entries.map((name) => {
											const option = names.indexOf(name);
											return (
												<button
													key={name}
													id={`${menuId}-${option}`}
													type="button"
													role="option"
													aria-selected={selected === option}
													tabIndex={-1}
													onMouseDown={(event) => event.preventDefault()}
													onClick={() => select(editor, name)}
												>
													/{name}
												</button>
											);
										})}
									</fieldset>
								),
						)}
					</div>
				</div>
			);
		},
	};
}
