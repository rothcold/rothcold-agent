import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type RefObject,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Channel, Chat } from "./chat.ts";
import { WorkspaceIcon } from "./workspace-icon.tsx";
import { isPlainLinkClick } from "./workspace-nav.tsx";

type SearchProps = {
	channels: Channel[];
	chats: Chat[];
	setOpen: (open: boolean) => void;
	onThreadOpen: (thread: Chat, opener: HTMLButtonElement) => void;
};

type SearchResults = {
	groups: Channel[];
	threads: { chat: Chat; category: string | undefined }[];
	label: string;
};

function findWorkspaceMatches(
	channels: Channel[],
	chats: Chat[],
	query: string,
): SearchResults {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const matches = (label: string) =>
		terms.every((term) => label.toLowerCase().includes(term));
	const groups = channels.filter((channel) => matches(channel.name));
	const threads = chats
		.map((chat) => ({
			chat,
			category: channels.find((group) => group.id === chat.channel)?.name,
		}))
		.filter(({ chat, category }) => matches(`${chat.title} ${category ?? ""}`));
	const count = threads.length + groups.length;
	const suffix = count === 1 ? "match" : "matches";
	const label = terms.length
		? `${count} ${suffix}`
		: "Thread titles and categories";
	return { groups, threads, label };
}

function resultNavigation(
	event: ReactKeyboardEvent<HTMLUListElement>,
	input: HTMLInputElement | null,
) {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	const links = [...event.currentTarget.querySelectorAll("a")];
	const active = document.activeElement;
	if (!(active instanceof HTMLAnchorElement)) return;
	const index = links.indexOf(active);
	if (index < 0) return;
	event.preventDefault();
	if (event.key === "ArrowUp" && index === 0) input?.focus();
	else links[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
}

function WorkspaceSearchResults({
	matches,
	results,
	input,
	close,
	openThread,
}: {
	matches: SearchResults;
	results: RefObject<HTMLUListElement | null>;
	input: RefObject<HTMLInputElement | null>;
	close: () => void;
	openThread: (chat: Chat) => void;
}) {
	return (
		<>
			<p className="search-scope" role="status">
				{matches.label}
			</p>
			<ul
				ref={results}
				className="search-results"
				onKeyDown={(event) => resultNavigation(event, input.current)}
			>
				{matches.groups.map((group) => (
					<li key={group.id}>
						<a href={`#channel/${group.id}`} onClick={close}>
							<span aria-hidden="true" className="hash">
								#
							</span>
							<span>{group.name}</span>
							<small>Category</small>
						</a>
					</li>
				))}
				{matches.threads.map(({ chat, category }) => (
					<li key={chat.id}>
						<a
							href={`#${chat.id}`}
							onClick={(event) => {
								if (isPlainLinkClick(event)) openThread(chat);
								close();
							}}
						>
							<WorkspaceIcon name="thread" />
							<span>{chat.title}</span>
							<small>{category}</small>
						</a>
					</li>
				))}
			</ul>
		</>
	);
}

function useSearchShortcut(open: () => void) {
	useEffect(() => {
		function shortcut(event: KeyboardEvent) {
			if (
				event.key.toLowerCase() !== "k" ||
				!(event.ctrlKey || event.metaKey) ||
				event.altKey ||
				event.isComposing ||
				document.querySelector(".nav-drawer[open]")
			)
				return;
			event.preventDefault();
			open();
		}
		window.addEventListener("keydown", shortcut);
		return () => window.removeEventListener("keydown", shortcut);
	}, [open]);
}

export function WorkspaceSearch({
	channels,
	chats,
	setOpen,
	onThreadOpen,
}: SearchProps) {
	const dialog = useRef<HTMLDialogElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const results = useRef<HTMLUListElement>(null);
	const [query, setQuery] = useState("");
	const matches = findWorkspaceMatches(channels, chats, query);
	const open = useCallback(() => {
		if (!dialog.current?.open) dialog.current?.showModal();
		input.current?.focus();
		setOpen(true);
	}, [setOpen]);
	useSearchShortcut(open);

	function close() {
		dialog.current?.close();
		setQuery("");
		setOpen(false);
	}
	return (
		<>
			<button
				className="search-trigger"
				aria-label="Find threads or categories"
				ref={trigger}
				type="button"
				aria-haspopup="dialog"
				aria-keyshortcuts="Control+K Meta+K"
				onClick={open}
			>
				<WorkspaceIcon name="search" />
				<span>Find threads or categories</span>
				<kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} K</kbd>
			</button>
			<dialog
				ref={dialog}
				className="search-dialog"
				aria-label="Find threads or categories"
				onClose={() => {
					setQuery("");
					setOpen(false);
				}}
				onPointerDown={(e) => {
					if (e.target === e.currentTarget) close();
				}}
			>
				<div className="search-panel">
					<form
						className="search-field"
						onSubmit={(e) => {
							e.preventDefault();
							results.current?.querySelector("a")?.click();
						}}
					>
						<WorkspaceIcon name="search" />
						<input
							ref={input}
							aria-label="Filter thread titles and categories"
							placeholder="Filter thread titles and categories…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "ArrowDown" && !e.nativeEvent.isComposing) {
									e.preventDefault();
									results.current?.querySelector("a")?.focus();
								}
							}}
						/>
						<button
							className="icon-button quiet"
							type="button"
							aria-label="Cancel search"
							onClick={close}
						>
							<WorkspaceIcon name="close" />
						</button>
					</form>
					<WorkspaceSearchResults
						matches={matches}
						results={results}
						input={input}
						close={close}
						openThread={(chat) => {
							if (trigger.current) onThreadOpen(chat, trigger.current);
						}}
					/>
				</div>
			</dialog>
		</>
	);
}
