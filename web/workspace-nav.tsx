import {
	useEffect,
	useRef,
	useState,
	type MouseEvent,
	type ReactNode,
} from "react";
import type { Channel, Chat } from "./chat.ts";
import { WorkspaceIcon } from "./workspace-icon.tsx";

export function WorkspaceRail({
	selected,
	total,
	category,
	close,
}: {
	selected: string;
	total: number;
	category?: string;
	close?: () => void;
}) {
	return (
		<nav className="workspace-rail" aria-label="Workspace views">
			<a
				className="rail-brand"
				href={`#channel/${category ?? "general"}`}
				aria-label="Rothcold workspace"
				onClick={close}
			>
				<img className="mark" src="/brand/icon-dark.svg" alt="" />
				<span className="sr-only">Rothcold workspace</span>
			</a>
			<a
				href={`#channel/${category ?? "general"}`}
				data-active={
					selected !== "inbox" &&
					selected !== "settings" &&
					selected !== "archive"
				}
				onClick={close}
			>
				<WorkspaceIcon name="workspace" />
				<span>Threads</span>
			</a>
			{/* biome-ignore lint/a11y/useValidAnchor: #inbox is a bookmarkable workspace route. */}
			<a
				href="#inbox"
				aria-label={`Notifications ${total} unread`}
				aria-current={selected === "inbox" ? "page" : undefined}
				onClick={close}
			>
				<span className="rail-icon">
					<WorkspaceIcon name="inbox" />
					{total > 0 && (
						<span className="rail-count">{total > 99 ? "99+" : total}</span>
					)}
				</span>
				<span>Inbox</span>
			</a>
		</nav>
	);
}

type NavigationProps = {
	channels: Channel[];
	chats: Chat[];
	unread: Map<string, number>;
	total: number;
	selected: string;
	category?: string;
	setDrawerOpen: (open: boolean) => void;
	onDesktopCategoryOpen: (id: string) => void;
	onThreadOpen: (thread: Chat, opener: HTMLAnchorElement) => void;
	startThread: (id: string) => void;
	children: ReactNode;
};

type SidebarProps = Omit<NavigationProps, "setDrawerOpen"> & {
	mobile: boolean;
	collapsed: ReadonlySet<string>;
	close: () => void;
	toggle: (id: string) => void;
};

export function isPlainLinkClick(event: MouseEvent<HTMLAnchorElement>) {
	return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function ThreadLink({
	thread,
	unread,
	active,
	open,
	close,
}: {
	thread: Chat;
	unread: number | undefined;
	active: boolean;
	open: NavigationProps["onThreadOpen"];
	close: () => void;
}) {
	return (
		<li>
			<a
				href={`#${thread.id}`}
				aria-current={active ? "page" : undefined}
				onClick={(event) => {
					if (isPlainLinkClick(event)) open(thread, event.currentTarget);
					close();
				}}
			>
				<WorkspaceIcon name="thread" />
				<span className="thread-title">{thread.title}</span>
				{unread !== undefined && (
					<small className="badge">
						{unread}
						<span className="sr-only"> unread</span>
					</small>
				)}
			</a>
		</li>
	);
}

function CategoryGroup({
	channel,
	sidebar,
}: {
	channel: Channel;
	sidebar: SidebarProps;
}) {
	const {
		chats,
		unread,
		collapsed,
		category,
		mobile,
		onDesktopCategoryOpen,
		onThreadOpen,
		selected,
		startThread,
		toggle,
		close,
	} = sidebar;
	const threads = chats.filter((thread) => thread.channel === channel.id);
	const count = threads.reduce(
		(n, thread) => n + (unread.get(thread.id) ?? 0),
		0,
	);
	const expanded = !collapsed.has(channel.id);
	const active = category === channel.id;
	return (
		<div className="nav-group">
			<div className="category-row" data-active={active}>
				<button
					className="disclose quiet"
					type="button"
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${channel.name}`}
					onClick={() => toggle(channel.id)}
				>
					<WorkspaceIcon name="forward" />
				</button>
				<a
					href={`#channel/${channel.id}`}
					aria-current={active ? "location" : undefined}
					onClick={(event) => {
						if (!mobile && isPlainLinkClick(event))
							onDesktopCategoryOpen(channel.id);
						if (!expanded) toggle(channel.id);
						close();
					}}
				>
					<span aria-hidden="true" className="hash">
						#
					</span>
					<span className="thread-title">{channel.name}</span>
					{count > 0 && (
						<small aria-hidden="true" className="badge">
							{count}
						</small>
					)}
				</a>
			</div>
			{expanded && (
				<ul className="thread-links">
					{threads.map((thread) => (
						<ThreadLink
							key={thread.id}
							thread={thread}
							unread={unread.get(thread.id)}
							active={selected === thread.id}
							open={onThreadOpen}
							close={close}
						/>
					))}
					{active && (
						<li>
							<a
								className="start-thread"
								href={`#channel/${channel.id}`}
								onClick={() => {
									close();
									startThread(channel.id);
								}}
							>
								<WorkspaceIcon name="plus" /> New thread
							</a>
						</li>
					)}
				</ul>
			)}
		</div>
	);
}

function WorkspaceSidebar(props: SidebarProps) {
	const { mobile, close, selected, category, total, channels, children } =
		props;
	return (
		<aside className="sidebar" aria-label="Workspace navigation">
			<div className="workspace-brand">
				<div>
					<strong>rothcold-agent</strong>
					<small>Private workspace</small>
				</div>
				{mobile && (
					<button
						className="icon-button quiet"
						type="button"
						onClick={close}
						aria-label="Close navigation"
					>
						<WorkspaceIcon name="close" />
					</button>
				)}
			</div>
			{mobile && (
				<WorkspaceRail
					selected={selected}
					category={category}
					total={total}
					close={close}
				/>
			)}
			<div className="sidebar-scroll">
				<h2 className="nav-heading">Categories</h2>
				<nav aria-label="Categories">
					{channels.map((channel) => (
						<CategoryGroup key={channel.id} channel={channel} sidebar={props} />
					))}
				</nav>
				<a
					className="archive-link quiet"
					href="#archive"
					aria-current={selected === "archive" ? "page" : undefined}
				>
					Archived
				</a>
				{children}
			</div>
		</aside>
	);
}

export function WorkspaceNav({
	setDrawerOpen,
	...sidebarProps
}: NavigationProps) {
	const { selected, total } = sidebarProps;
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [mobile, setMobile] = useState(
		() => matchMedia("(max-width: 760px)").matches,
	);
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const media = matchMedia("(max-width: 760px)");
		const change = () => {
			if (!media.matches) setDrawerOpen(false);
			setMobile(media.matches);
		};
		media.addEventListener("change", change);
		return () => media.removeEventListener("change", change);
	}, [setDrawerOpen]);
	useEffect(() => {
		const close = () => dialog.current?.close();
		window.addEventListener("hashchange", close);
		return () => window.removeEventListener("hashchange", close);
	}, []);
	function close() {
		dialog.current?.close();
	}
	function toggle(id: string) {
		setCollapsed((old) => {
			const next = new Set(old);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}
	const sidebar = (
		<WorkspaceSidebar
			{...sidebarProps}
			mobile={mobile}
			collapsed={collapsed}
			toggle={toggle}
			close={close}
		/>
	);
	if (!mobile)
		return selected === "inbox" || selected === "settings" ? null : sidebar;
	return (
		<>
			<button
				className="mobile-nav quiet"
				aria-label="Workspace"
				type="button"
				aria-haspopup="dialog"
				onClick={() => {
					dialog.current?.showModal();
					setDrawerOpen(true);
				}}
			>
				<img className="mark" src="/brand/icon-dark.svg" alt="" />
				{total > 0 && (
					<span className="badge" aria-hidden="true">
						{total}
					</span>
				)}
			</button>
			<dialog
				className="nav-drawer"
				ref={dialog}
				onClose={() => setDrawerOpen(false)}
				aria-label="Workspace navigation"
				onPointerDown={(e) => {
					if (e.target === e.currentTarget) close();
				}}
			>
				{sidebar}
			</dialog>
		</>
	);
}
