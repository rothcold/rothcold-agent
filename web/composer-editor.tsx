import type { Editor, JSONContent } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { Markdown, type MarkdownManager } from "@tiptap/markdown";
import {
	Fragment,
	type Node as ProseMirrorNode,
	Slice,
} from "@tiptap/pm/model";
import { EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import {
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
	type Ref,
	type RefObject,
} from "react";
import type { EditorView } from "@tiptap/pm/view";
import { WorkspaceIcon } from "./workspace-icon.tsx";

export const composerLimit = 8000;
export type ComposerEditorHandle = { clear: () => void };

function looksLikeMarkdown(text: string) {
	return (
		!text.trimStart().startsWith("/") &&
		(/^[ \t]{0,3}(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s|```|~~~|(?:---|\*\*\*|___)\s*$)/m.test(
			text,
		) ||
			/(\*{1,3}|_{1,3}|~~|`+)[^\s\n].*?\1|\[[^\]\n]+\]\([^\n)]+\)/.test(text))
	);
}

const ChatStarterKit = StarterKit.extend({
	addExtensions() {
		return (
			this.parent?.().map((extension) => {
				if (extension.name === "codeBlock")
					return extension.extend({
						renderMarkdown(node, helpers) {
							const body = helpers.renderChildren(node.content ?? []);
							const info = node.attrs?.language ?? "";
							const delimiter = info.includes("`") ? "~" : "`";
							const runs = delimiter === "~" ? /~+/g : /`+/g;
							let length = 3;
							for (const run of body.matchAll(runs))
								length = Math.max(length, run[0].length + 1);
							const fence = delimiter.repeat(length);
							const sep = info.startsWith(delimiter) ? " " : "";
							return `${fence}${sep}${info}\n${body}\n${fence}`;
						},
					});
				if (extension.name === "hardBreak")
					return extension.extend({
						addAttributes() {
							return { bare: { default: false, rendered: false } };
						},
						renderMarkdown: (node) => (node.attrs?.bare ? "\n" : "  \n"),
					});
				return extension;
			}) ?? []
		);
	},
}).configure({ link: { openOnClick: false, autolink: false } });

function pasteableMarkdown(markdown: MarkdownManager, text: string) {
	const supported = new Set([
		"blockquote",
		"br",
		"code",
		"codespan",
		"del",
		"em",
		"escape",
		"heading",
		"hr",
		"link",
		"list",
		"list_item",
		"paragraph",
		"space",
		"strong",
		"text",
	]);
	let lossless = true;
	const { instance } = markdown;
	instance.walkTokens(instance.lexer(text), (token) => {
		if (
			!supported.has(token.type) ||
			(token.type === "list_item" && token.task) ||
			// TipTap drops fenced code tokens whose raw text starts with indentation.
			(token.type === "code" && /^ {1,3}(?:```|~~~)/.test(token.raw))
		)
			lossless = false;
	});
	return lossless;
}

function literalPaste(text: string): JSONContent[] {
	const content: JSONContent[] = [];
	for (const [i, line] of text.split(/\r\n?|\n/).entries()) {
		if (i) content.push({ type: "hardBreak", attrs: { bare: true } });
		if (line) content.push({ type: "text", text: line });
	}
	return content;
}

function hasNonRoundTrippingBreak(doc: ProseMirrorNode) {
	let found = false;
	doc.descendants((node, _position, parent, index) => {
		// Bare pasted breaks and terminal breaks in any textblock can change on reparse.
		if (
			node.type.name === "hardBreak" &&
			(node.attrs.bare || index === (parent?.childCount ?? 0) - 1)
		)
			found = true;
		return !found;
	});
	return found;
}

type ToolbarItem = {
	icon:
		| "bold"
		| "italic"
		| "strike"
		| "orderedList"
		| "bulletList"
		| "quote"
		| "code"
		| "codeBlock";
	label: string;
	active: (editor: Editor) => boolean;
	run: (editor: Editor) => void;
	sepBefore?: boolean;
};

const toolbarItems: ToolbarItem[] = [
	{
		icon: "bold",
		label: "Bold",
		active: (editor) => editor.isActive("bold"),
		run: (editor) => {
			editor.chain().focus().toggleBold().run();
		},
	},
	{
		icon: "italic",
		label: "Italic",
		active: (editor) => editor.isActive("italic"),
		run: (editor) => {
			editor.chain().focus().toggleItalic().run();
		},
	},
	{
		icon: "strike",
		label: "Strikethrough",
		active: (editor) => editor.isActive("strike"),
		run: (editor) => {
			editor.chain().focus().toggleStrike().run();
		},
	},
	{
		icon: "orderedList",
		label: "Ordered list",
		sepBefore: true,
		active: (editor) => editor.isActive("orderedList"),
		run: (editor) => {
			editor.chain().focus().toggleOrderedList().run();
		},
	},
	{
		icon: "bulletList",
		label: "Bullet list",
		active: (editor) => editor.isActive("bulletList"),
		run: (editor) => {
			editor.chain().focus().toggleBulletList().run();
		},
	},
	{
		icon: "quote",
		label: "Blockquote",
		sepBefore: true,
		active: (editor) => editor.isActive("blockquote"),
		run: (editor) => {
			editor.chain().focus().toggleBlockquote().run();
		},
	},
	{
		icon: "code",
		label: "Inline code",
		active: (editor) => editor.isActive("code"),
		run: (editor) => {
			editor.chain().focus().toggleCode().run();
		},
	},
	{
		icon: "codeBlock",
		label: "Code block",
		active: (editor) => editor.isActive("codeBlock"),
		run: (editor) => {
			editor.chain().focus().toggleCodeBlock().run();
		},
	},
];

const compactComposer = "(max-width: 760px), (max-height: 510px)";
type ToolbarMode = "auto" | "open" | "closed";

function useComposerToolbar() {
	const [compact, setCompact] = useState(
		() => matchMedia(compactComposer).matches,
	);
	const [mode, setMode] = useState<ToolbarMode>("auto");
	useEffect(() => {
		const media = matchMedia(compactComposer);
		const sync = () => setCompact(media.matches);
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, []);
	const open = mode === "open" || (mode === "auto" && !compact);
	return { mode, open, toggle: () => setMode(open ? "closed" : "open") };
}

type ComposerProps = {
	id: string;
	label: string;
	placeholder: string;
	initialMarkdown: string;
	initialLiteralContent?: JSONContent;
	onMarkdownChange: (markdown: string, literalContent?: JSONContent) => void;
	blocked: boolean;
	hasAttachments: boolean;
	actions: (limit: ReactNode, formatToggle: ReactNode) => ReactNode;
	ref: Ref<ComposerEditorHandle>;
};

function composerAttributes(
	id: string,
	label: string,
	blocked: boolean,
	limitError: string,
) {
	const attributes: Record<string, string> = {
		id,
		class: "composer-editor",
		role: "textbox",
		"aria-label": label,
		"aria-multiline": "true",
	};
	if (blocked) {
		attributes["aria-disabled"] = "true";
		attributes.tabindex = "-1";
	}
	if (limitError) {
		attributes["aria-invalid"] = "true";
		attributes["aria-describedby"] = limitError;
	}
	return attributes;
}

function composerEnter(
	editor: Editor | null,
	view: EditorView,
	event: KeyboardEvent,
	hasAttachments: boolean,
) {
	if (event.key !== "Enter" || event.metaKey || event.altKey) return false;
	event.preventDefault();
	if (!editor?.isEditable) return true;
	if (event.ctrlKey || event.shiftKey) {
		if (editor.isActive("codeBlock")) editor.commands.newlineInCode();
		else editor.commands.setHardBreak();
		return true;
	}
	const markdown = editor.getMarkdown();
	if (markdown.length <= composerLimit && (markdown.trim() || hasAttachments)) {
		view.dom.closest("form")?.requestSubmit();
	}
	return true;
}

function composerPaste(
	markdown: MarkdownManager | undefined,
	view: EditorView,
	event: ClipboardEvent,
	keepLiteralDraft: RefObject<boolean>,
) {
	const data = event.clipboardData;
	const text = data?.getData("text/plain");
	if (
		!markdown ||
		!text ||
		data?.getData("text/html") ||
		view.state.selection.$from.parent.type.spec.code
	)
		return false;
	const { schema } = view.state;
	let slice: Slice;
	if (looksLikeMarkdown(text) && pasteableMarkdown(markdown, text)) {
		slice = Slice.maxOpen(schema.nodeFromJSON(markdown.parse(text)).content);
	} else {
		keepLiteralDraft.current = true;
		const nodes = literalPaste(text).map((node) => schema.nodeFromJSON(node));
		slice = new Slice(Fragment.fromArray(nodes), 0, 0);
	}
	view.dispatch(
		view.state.tr
			.replaceSelection(slice)
			.setMeta("paste", true)
			.setMeta("uiEvent", "paste")
			.scrollIntoView(),
	);
	return true;
}

function useComposerDocument({
	id,
	label,
	placeholder,
	initialMarkdown,
	initialLiteralContent,
	onMarkdownChange,
	blocked,
	hasAttachments,
	ref,
}: Omit<ComposerProps, "actions">) {
	const [length, setLength] = useState(initialMarkdown.length);
	const [, setToolbarRevision] = useState(0);
	const tooLong = length > composerLimit;
	const errorId = `${id}-limit`;
	const keepLiteralDraft = useRef(Boolean(initialLiteralContent));
	const editor: Editor | null = useEditor({
		injectCSS: false,
		editable: !blocked,
		content: initialLiteralContent ?? initialMarkdown,
		contentType: initialLiteralContent ? "json" : "markdown",
		enablePasteRules: false,
		extensions: [
			ChatStarterKit,
			Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
			Placeholder.configure({ placeholder, showOnlyWhenEditable: false }),
		],
		onTransaction: () => {
			setToolbarRevision((n) => n + 1);
		},
		onUpdate: ({ editor }) => {
			const markdown = editor.getMarkdown();
			setLength(markdown.length);
			if (editor.isEmpty) keepLiteralDraft.current = false;
			const snapshot =
				keepLiteralDraft.current || hasNonRoundTrippingBreak(editor.state.doc);
			onMarkdownChange(markdown, snapshot ? editor.getJSON() : undefined);
		},
		editorProps: {
			attributes: composerAttributes(
				id,
				label,
				blocked,
				tooLong ? errorId : "",
			),
			handleDOMEvents: {
				// Leave composition Enter to the browser, not the ProseMirror keymap.
				keydown: (view, event) =>
					event.key === "Enter" && (event.isComposing || view.composing),
			},
			handleKeyDown: (view, event) =>
				composerEnter(editor, view, event, hasAttachments),
			handlePaste: (view, event) =>
				composerPaste(editor?.markdown, view, event, keepLiteralDraft),
		},
	});
	useLayoutEffect(() => {
		if (editor && editor.isEditable === blocked)
			editor.setEditable(!blocked, false);
	}, [editor, blocked]);
	useImperativeHandle(
		ref,
		() => ({
			clear() {
				keepLiteralDraft.current = false;
				editor?.commands.clearContent(false);
				setLength(0);
			},
		}),
		[editor],
	);
	return { editor, tooLong, errorId };
}

function ComposerToolbar({
	editor,
	blocked,
	mode,
}: {
	editor: Editor | null;
	blocked: boolean;
	mode: ToolbarMode;
}) {
	return (
		<div
			className="composer-toolbar"
			data-toolbar-mode={mode}
			role="toolbar"
			aria-label="Formatting"
		>
			{toolbarItems.map((item, index) => (
				<span className="toolbar-slot" key={item.icon}>
					{item.sepBefore && (
						<span className="toolbar-sep" aria-hidden="true" />
					)}
					<button
						className={
							index === 0
								? "quiet toolbar-button has-tip tip-start"
								: "quiet toolbar-button has-tip"
						}
						type="button"
						aria-label={item.label}
						aria-pressed={Boolean(editor && item.active(editor))}
						data-tip={item.label}
						disabled={blocked || !editor}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => {
							if (editor) item.run(editor);
						}}
					>
						<WorkspaceIcon name={item.icon} />
					</button>
				</span>
			))}
		</div>
	);
}

export function ComposerEditor({ actions, ...documentProps }: ComposerProps) {
	const { editor, tooLong, errorId } = useComposerDocument(documentProps);
	const toolbar = useComposerToolbar();
	const toggleLabel = toolbar.open ? "Hide formatting" : "Show formatting";
	return (
		<>
			{toolbar.open && (
				<ComposerToolbar
					editor={editor}
					blocked={documentProps.blocked}
					mode={toolbar.mode}
				/>
			)}
			<EditorContent className="composer-editor-wrap" editor={editor} />
			{actions(
				tooLong && (
					<p className="composer-limit" id={errorId} role="alert">
						Over 8,000<span className="sr-only"> characters</span>
					</p>
				),
				<button
					className="quiet composer-icon-button has-tip"
					type="button"
					aria-label={toggleLabel}
					aria-pressed={toolbar.open}
					data-tip={toggleLabel}
					disabled={documentProps.blocked}
					onMouseDown={(event) => event.preventDefault()}
					onClick={toolbar.toggle}
				>
					<WorkspaceIcon name="format" />
				</button>,
			)}
		</>
	);
}
