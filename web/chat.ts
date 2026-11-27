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
export type Attachment = {
	id: string;
	filename: string;
	mime: string;
	kind: "image" | "video" | "audio" | "file";
	size: number;
};
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
export class SessionExpired extends Error {}

async function decodeResponse<T>(
	res: Response,
	sessionRequired: boolean,
): Promise<T> {
	if (res.ok) return res.json();
	if (sessionRequired && res.status === 401)
		throw new SessionExpired(
			"This device session expired or was revoked. Sign in again.",
		);
	throw new Error(await res.text());
}

async function requestJson<T>(
	url: string,
	options: RequestInit,
	sessionRequired = false,
): Promise<T> {
	const response = await fetch(url, { ...options, redirect: "error" });
	return decodeResponse<T>(response, sessionRequired);
}

export async function api<T>(
	path: string,
	server: string,
	data?: Record<string, unknown>,
): Promise<T> {
	const headers = new Headers({ "X-Rothcold-Server": server });
	if (data) headers.set("Content-Type", "application/json");
	return requestJson<T>(
		`/api/${path}`,
		{
			method: data ? "POST" : "GET",
			headers,
			credentials: "same-origin",
			body: data && JSON.stringify(data),
		},
		path !== "login",
	);
}

export function connection<T>(
	path: "config" | "check",
	server?: string,
): Promise<T> {
	return requestJson<T>(`/connection/${path}`, {
		headers: server ? { "X-Rothcold-Server": server } : undefined,
		credentials: "omit",
	});
}

export async function upload(
	file: File,
	server: string,
	purpose: "turn" | "avatar",
): Promise<Attachment> {
	return requestJson<Attachment>("/api/attachments", {
		method: "POST",
		headers: {
			"X-Rothcold-Server": server,
			"X-Rothcold-Filename": encodeURIComponent(file.name),
			"X-Rothcold-Purpose": purpose,
			"Content-Type": file.type || "application/octet-stream",
		},
		credentials: "same-origin",
		body: file,
	});
}
