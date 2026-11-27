import type { Channel, Chat, WorkspaceDirectory } from "./chat.ts";

export function activeDirectory({ channels, chats }: WorkspaceDirectory) {
	const active = channels.filter((channel) => !channel.archived);
	const ids = new Set(active.map((channel) => channel.id));
	return {
		channels: active,
		chats: chats.filter((chat) => !chat.archived && ids.has(chat.channel)),
	};
}

export function archivedThreadReason(chat: Chat, channel: Channel) {
	if (chat.archived && channel.archived)
		return "Restore the category and this thread to reply.";
	if (channel.archived) return "Restore the category to reply.";
	if (chat.archived) return "Restore this thread to reply.";
	return "";
}

export function ArchivePane({ channels, chats }: WorkspaceDirectory) {
	const archivedChannels = channels.filter((channel) => channel.archived);
	const names = new Map(channels.map((channel) => [channel.id, channel.name]));
	const archivedIds = new Set(archivedChannels.map((channel) => channel.id));
	const archivedThreads = chats.filter(
		(chat) => chat.archived || archivedIds.has(chat.channel),
	);
	return (
		<section className="pane archive-pane">
			<div className="pane-head">
				<p className="eyebrow">Workspace</p>
				<h1>Archived</h1>
			</div>
			<div className="pane-scroll">
				<p className="hint">Open a category or thread to view or restore it.</p>
				<h2 className="section-title">Categories</h2>
				{archivedChannels.length === 0 && (
					<p className="empty">No archived categories.</p>
				)}
				<ul className="items">
					{archivedChannels.map((channel) => (
						<li key={channel.id}>
							<a href={`#channel/${channel.id}`}>{channel.name}</a>
						</li>
					))}
				</ul>
				<h2 className="section-title">Threads</h2>
				{archivedThreads.length === 0 && (
					<p className="empty">No archived threads.</p>
				)}
				<ul className="items">
					{archivedThreads.map((chat) => (
						<li key={chat.id}>
							<a href={`#${chat.id}`}>
								<span>{chat.title}</span>
								<small>
									{names.get(chat.channel)} ·{" "}
									{chat.archived ? "Thread archived" : "Category archived"}
								</small>
							</a>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
