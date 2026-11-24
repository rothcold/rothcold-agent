import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Channel, Chat, InboxEvent } from "./chat";

export function WorkspaceNav({
	channels,
	chats,
	events,
	selected,
	category,
	markRead,
	children,
}: {
	channels: Channel[];
	chats: Chat[];
	events: InboxEvent[] | null;
	selected: string;
	category?: string;
	markRead: (id: string) => void;
	children: ReactNode;
}) {
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [mobile, setMobile] = useState(
		() => matchMedia("(max-width: 760px)").matches,
	);
	const dialog = useRef<HTMLDialogElement>(null);
	const unread = new Map<string, number>();
	for (const event of events ?? []) {
		if (event.unread) unread.set(event.chat, (unread.get(event.chat) ?? 0) + 1);
	}
	const total = events?.reduce((n, e) => n + e.unread, 0);
	useEffect(() => {
		const media = matchMedia("(max-width: 760px)");
		const change = () => setMobile(media.matches);
		media.addEventListener("change", change);
		return () => media.removeEventListener("change", change);
	}, []);
	useEffect(() => {
		const close = () => dialog.current?.close();
		window.addEventListener("hashchange", close);
		return () => window.removeEventListener("hashchange", close);
	}, []);
	function toggle(id: string) {
		setCollapsed((old) => {
			const next = new Set(old);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}
	const sidebar = (
		<aside className="sidebar" aria-label="Workspace navigation">
			<div className="workspace-brand">
				<span className="mark" aria-hidden="true">
					R
				</span>
				<div>
					<strong>rothcold-agent</strong>
					<small>Private workspace</small>
				</div>
				{mobile && (
					<button
						className="drawer-close"
						type="button"
						onClick={() => dialog.current?.close()}
						aria-label="Close navigation"
					>
						×
					</button>
				)}
			</div>
			{/* biome-ignore lint/a11y/useValidAnchor: #inbox is the bookmarkable inbox route; clicking also dismisses the drawer. */}
			<a
				className="inbox-link"
				href="#inbox"
				aria-current={selected === "inbox" ? "page" : undefined}
				onClick={() => dialog.current?.close()}
			>
				<span aria-hidden="true">▤</span> Notifications{" "}
				<span className="badge">{total ?? "…"} unread</span>
			</a>
			<h2 className="nav-heading">Categories</h2>
			<nav aria-label="Categories">
				{channels.map((c) => {
					const threads = chats.filter((t) => t.channel === c.id);
					const expanded = !collapsed.has(c.id);
					return (
						<div className="nav-group" key={c.id}>
							<div className="category-row">
								<button
									className="disclose"
									type="button"
									aria-expanded={expanded}
									aria-label={`${expanded ? "Collapse" : "Expand"} ${c.name}`}
									onClick={() => toggle(c.id)}
								>
									<span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
								</button>
								<a
									href={`#channel/${c.id}`}
									aria-current={
										category === c.id &&
										(!selected || selected === `channel/${c.id}`)
											? "page"
											: undefined
									}
									onClick={() => {
										if (!expanded) toggle(c.id);
										dialog.current?.close();
									}}
								>
									<span aria-hidden="true">#</span> {c.name}
								</a>
							</div>
							{expanded && (
								<ul className="thread-links">
									{threads.map((t) => (
										<li key={t.id}>
											<a
												href={`#${t.id}`}
												aria-current={selected === t.id ? "page" : undefined}
												onClick={() => {
													dialog.current?.close();
													markRead(t.id);
												}}
											>
												<span>{t.title}</span>
												{unread.has(t.id) && (
													<small>{unread.get(t.id)} unread</small>
												)}
											</a>
										</li>
									))}
									<li>
										<a
											className="start-thread"
											href={`#channel/${c.id}`}
											onClick={() => dialog.current?.close()}
										>
											<span aria-hidden="true">＋</span> New thread
										</a>
									</li>
								</ul>
							)}
						</div>
					);
				})}
			</nav>
			{children}
		</aside>
	);
	if (!mobile) return sidebar;
	return (
		<>
			<div className="mobile-bar">
				<button
					type="button"
					aria-haspopup="dialog"
					onClick={() => dialog.current?.showModal()}
				>
					<span aria-hidden="true">☰</span> Workspace
				</button>
				<span>{total ?? "…"} unread</span>
			</div>
			<dialog
				className="nav-drawer"
				ref={dialog}
				aria-label="Workspace navigation"
				onPointerDown={(e) => {
					if (e.target === e.currentTarget) dialog.current?.close();
				}}
			>
				{sidebar}
			</dialog>
		</>
	);
}
