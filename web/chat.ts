export type Archived = 0 | 1;
export type Chat = {
	id: string;
	title: string;
	channel: string;
	archived: Archived;
};
export type Channel = { id: string; name: string; archived: Archived };
export type WorkspaceDirectory = { chats: Chat[]; channels: Channel[] };
export type InboxEvent = {
	request: string;
	chat: string;
	channel: string;
	unread: 0 | 1;
	title: string;
	preview: string;
};
import type { Attachment } from "./noise-link.ts";
export type { Attachment } from "./noise-link.ts";
export type Identity = { name: string; avatar: string | null };
export type Profile = {
	owner: Identity;
	agent: Identity;
	backends: (Identity & { id: string; kind: string; updated_at: number })[];
};
export type Draft = {
	id: string;
	text: string;
	approval?: string;
	attachments?: string[];
};
export type TurnUpdate = {
	id: string;
	kind: "progress" | "commentary";
	choices?: ("once" | "session" | "deny")[];
	text: string;
};
export type Turn = Pick<Draft, "id" | "text"> & {
	attachments?: Attachment[];
	state:
		| "queued"
		| "accepted"
		| "reserved"
		| "unknown"
		| "released"
		| "answered";
	answer: string | null;
	updates: TurnUpdate[];
};
export function requestFor(
	text: string,
	previous: Draft | null,
	attachments = previous?.attachments ?? [],
): Draft {
	if (
		previous?.text === text &&
		(previous.attachments?.length ?? 0) === attachments.length &&
		attachments.every((id, index) => previous.attachments?.[index] === id)
	)
		return previous;
	const draft: Draft = { id: crypto.randomUUID(), text };
	if (attachments.length) draft.attachments = attachments;
	return draft;
}
export function replyDraft(
	text: string,
	previous: Draft | null,
	turns: Turn[],
): Draft {
	const draft = requestFor(text, previous);
	if (!text.trimStart().startsWith("/")) return draft;
	// Pin the prompt when the slash draft starts, not when Send eventually runs.
	if (previous?.text.trimStart().startsWith("/"))
		return { ...draft, approval: previous.approval };
	const cards = turns.flatMap((turn) =>
		turn.updates.filter((update) => update.choices?.length),
	);
	return { ...draft, approval: cards.length === 1 ? cards[0].id : undefined };
}
export function pending(turns: Turn[]): boolean {
	return turns.some((t) => t.state !== "answered" && t.state !== "released");
}
