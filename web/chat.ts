export type Chat = { id: string; title: string; channel: string };
export type Channel = { id: string; name: string };
export type InboxEvent = {
	request: string;
	chat: string;
	channel: string;
	unread: 0 | 1;
};
export type Draft = { id: string; text: string };
export type TurnUpdate = {
	id: string;
	kind: "progress" | "commentary";
	text: string;
};
export type Turn = Draft & {
	state: "queued" | "accepted" | "reserved" | "unknown" | "answered";
	answer: string | null;
	updates: TurnUpdate[];
};
export function requestFor(text: string, previous: Draft | null): Draft {
	return previous?.text === text ? previous : { id: crypto.randomUUID(), text };
}
export function pending(turns: Turn[]): boolean {
	return turns.some((t) => t.state !== "answered");
}
export async function api<T>(
	path: string,
	session?: string,
	data?: object,
): Promise<T> {
	const headers: Record<string, string> = {};
	if (session) headers.Authorization = `Bearer ${session}`;
	if (data) headers["Content-Type"] = "application/json";
	const res = await fetch(`/api/${path}`, {
		method: data ? "POST" : "GET",
		headers,
		credentials: "omit",
		redirect: "error",
		body: data && JSON.stringify(data),
	});
	if (!res.ok) {
		if (res.status === 401) {
			throw Error(
				session
					? "Session expired. Reload and sign in again."
					: "Invalid owner token.",
			);
		}
		throw Error(await res.text());
	}
	return res.json();
}
