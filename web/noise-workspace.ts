import type {
	Channel,
	Chat,
	Draft,
	Identity,
	InboxEvent,
	Profile,
	Turn,
	TurnUpdate,
	WorkspaceDirectory,
} from "./chat.ts";
import {
	type BrowserDevice,
	loadDevice,
	removeDevice,
	saveDevice,
} from "./noise-device.ts";
import {
	type Attachment,
	chunkBytes,
	control,
	downloadChunk,
	NoiseError,
	NoiseLink,
	SessionExpired,
} from "./noise-link.ts";

export type Backend = {
	id: string;
	label: string;
	path: string;
	scope: string;
};
export type Selection = { backend: Backend; pin: string };
export async function configuredBackends(): Promise<{
	defaultBackend: string;
	backends: Backend[];
}> {
	if (location.protocol !== "https:" || !isSecureContext)
		throw new Error("Open the trusted HTTPS workspace to connect.");
	const res = await fetch("/backends.json", {
		credentials: "omit",
		redirect: "error",
	});
	if (!res.ok) throw new Error("Could not load trusted backend choices.");
	return res.json();
}

export type Device = {
	id: string;
	name: string;
	created_at: number;
	expires_at: number;
};
type Send = { id: string; text: string; attachments?: string[] };
export type Choice = "once" | "session" | "deny";
type Page<T> = { items: T[]; next: string | null };
type ProfileValues = Pick<Profile, "owner" | "agent"> & {
	sync: null | {
		backend: string;
		refresh: "refreshed" | "offline" | "timed_out";
		name: boolean;
		avatar: boolean;
	};
};
export type IdentityPatch = {
	name?: string;
	avatar?: { type: "clear" } | { type: "set"; id: string };
};
type Archived<T extends { archived: 0 | 1 }> = Omit<T, "archived"> & {
	archived: boolean;
};
type Commands = {
	categories: [
		{ include_archived: boolean; after?: string | null },
		"categories",
		{ page: Page<Archived<Channel>> },
	];
	threads: [
		{ include_archived: boolean; after?: string | null },
		"threads",
		{ page: Page<Archived<Chat>> },
	];
	history: [
		{ chat: string; after?: string | null },
		"history",
		{ page: Page<Omit<Turn, "updates">> },
	];
	turn_updates: [
		{ chat: string; turn: string; after?: string | null },
		"turn_updates",
		{ page: Page<TurnUpdate> },
	];
	inbox: [
		{ after?: string | null },
		"inbox",
		{ page: Page<Omit<InboxEvent, "unread"> & { unread: boolean }> },
	];
	profile: [object, "profile", { profile: ProfileValues }];
	update_profile: [
		{ owner?: IdentityPatch; agent?: IdentityPatch },
		"profile",
		{ profile: ProfileValues },
	];
	sync_profile: [{ backend?: string }, "profile", { profile: ProfileValues }];
	profile_backends: [
		{ after?: string | null },
		"profile_backends",
		{ page: Page<Profile["backends"][number]> },
	];
	slash_catalog: [
		object,
		"slash_catalog",
		{ catalog: { commands: string[]; skills: string[] } | null },
	];
	devices: [
		{ after?: string | null },
		"devices",
		{ current: string; page: Page<Device> },
	];
	create_category: [{ name: string }, "category_created", { id: string }];
	rename_category: [
		{ id: string; name: string },
		"category_renamed",
		{ name: string },
	];
	archive_category: [
		{ id: string; archived: boolean },
		"archived",
		{ archived: boolean },
	];
	start_thread: [
		{ channel: string; message: Send },
		"thread_started",
		Omit<Chat, "archived"> & { fresh: boolean },
	];
	rename_thread: [
		{ id: string; title: string },
		"thread_renamed",
		{ title: string },
	];
	move_thread: [
		{ id: string; channel: string },
		"thread_moved",
		Pick<Chat, "id" | "channel">,
	];
	archive_thread: [
		{ id: string; archived: boolean },
		"archived",
		{ archived: boolean },
	];
	send_turn: [
		{ chat: string; message: Send },
		"turn_sent",
		{ id: string; fresh: boolean },
	];
	release_turn: [{ chat: string; id: string }, "ok", object];
	decide_approval: [{ chat: string; id: string; choice: Choice }, "ok", object];
	read_thread: [{ chat: string }, "ok", object];
	read_reply: [{ chat: string; id: string }, "ok", object];
	revoke_device: [{ id: string }, "revoked", { current: boolean }];
	logout: [object, "ok", object];
};
const outcomes: { [K in keyof Commands]: Commands[K][1] } = {
	categories: "categories",
	threads: "threads",
	history: "history",
	turn_updates: "turn_updates",
	inbox: "inbox",
	profile: "profile",
	update_profile: "profile",
	sync_profile: "profile",
	profile_backends: "profile_backends",
	slash_catalog: "slash_catalog",
	devices: "devices",
	create_category: "category_created",
	rename_category: "category_renamed",
	archive_category: "archived",
	start_thread: "thread_started",
	rename_thread: "thread_renamed",
	move_thread: "thread_moved",
	archive_thread: "archived",
	send_turn: "turn_sent",
	release_turn: "ok",
	decide_approval: "ok",
	read_thread: "ok",
	read_reply: "ok",
	revoke_device: "revoked",
	logout: "ok",
};
const reads = new Set<keyof Commands>([
	"categories",
	"threads",
	"history",
	"turn_updates",
	"inbox",
	"profile",
	"profile_backends",
	"slash_catalog",
	"devices",
]);
export type ConnectionLoss = { uncertain: boolean };
class LocalFileError extends Error {}
const lost = () =>
	new Error("The secure connection closed. Reconnect before continuing.");

const flag = (value: boolean) => (value ? (1 as const) : (0 as const));
export const selectionKey = ({ backend, pin }: Selection) =>
	`${location.origin}/${backend.scope}/${pin}`;

async function pages<T>(
	load: (after: string | null) => Promise<Page<T>>,
): Promise<T[]> {
	const items: T[] = [];
	const seen = new Set<string>();
	let after: string | null = null;
	do {
		const page = await load(after);
		items.push(...page.items);
		after = page.next;
		if (after !== null) {
			if (seen.has(after)) throw new Error("Invalid Noise page cursor.");
			seen.add(after);
		}
	} while (after !== null);
	return items;
}

async function browserProof(
	link: NoiseLink,
	device: Omit<BrowserDevice, "id">,
	id = "",
) {
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			device.privateKey,
			link.proof(id === "", device.publicKey, id),
		),
	);
	if (signature.length !== 64)
		throw new Error("Unexpected browser device proof format.");
	return { public_key: device.publicKey, signature: Array.from(signature) };
}

const MiB = 1024 * 1024;
const mimeByKind = {
	image: new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]),
	video: new Set(["video/mp4", "video/quicktime", "video/webm", "video/ogg"]),
	audio: new Set([
		"audio/mpeg",
		"audio/wav",
		"audio/flac",
		"audio/ogg",
		"audio/mp4",
		"audio/aac",
		"audio/webm",
	]),
	file: new Set<string>(),
} satisfies Record<Attachment["kind"], Set<string>>;

export class WorkspaceClient {
	readonly key: string;
	readonly #pin: number[];
	readonly #lifetime = new AbortController();
	#link?: NoiseLink;
	#device?: BrowserDevice;
	#tail: Promise<unknown> = Promise.resolve();
	#waiting = 0;
	#onExpired?: (error: SessionExpired) => void;
	#onLost?: (loss: ConnectionLoss) => void;
	#mutating = false;
	constructor(readonly selection: Selection) {
		if (!/^[0-9a-f]{64}$/.test(selection.pin))
			throw new Error(
				"Enter the independently verified 64-character Noise pin.",
			);
		this.key = selectionKey(selection);
		this.#pin = (selection.pin.match(/../g) ?? []).map((hex) =>
			Number.parseInt(hex, 16),
		);
	}
	get signal() {
		return this.#lifetime.signal;
	}
	get authorized() {
		return !!this.#device;
	}
	onExpired(listener?: (error: SessionExpired) => void) {
		this.#onExpired = listener;
	}
	onLost(listener: (loss: ConnectionLoss) => void) {
		this.#onLost = listener;
	}
	close() {
		this.#lifetime.abort(lost());
		this.#device = undefined;
		this.#link?.close();
	}
	#lost() {
		if (this.signal.aborted || !this.#device) return;
		const uncertain = this.#mutating;
		this.close();
		this.#onLost?.({ uncertain });
	}

	async #open() {
		this.signal.throwIfAborted();
		const link = await NoiseLink.connect(
			this.selection.backend.path,
			this.#pin,
			this.signal,
		);
		if (this.signal.aborted) {
			link.close();
			this.signal.throwIfAborted();
		}
		this.#link = link;
		link.onClosed = () => this.#lost();
		return link;
	}
	async check() {
		try {
			const link = await this.#open();
			const status = (await link.outcome({ type: "status" }, "status")) as {
				type: string;
				service: string;
				version: number;
			};
			if (status.service !== "rothcold-agent" || status.version !== 1)
				throw new Error("Unsupported Noise service or version.");
			const device = await loadDevice(this.key);
			if (device) {
				try {
					await this.#restore(link, device);
				} catch (error) {
					if (!(error instanceof NoiseError && error.code === "unauthorized"))
						throw error;
					link.close();
					await removeDevice(this.key, device.id);
					return new SessionExpired();
				}
				if (!link.open) throw lost();
				this.#device = device;
			}
		} catch (error) {
			this.close();
			throw error;
		}
	}
	async #restore(link: NoiseLink, device: BrowserDevice) {
		const message = {
			type: "resume_browser",
			pin: this.#pin,
			id: device.id,
			...(await browserProof(link, device, device.id)),
		};
		const result = (await link.outcome(message, "device")) as {
			type: string;
			device: Device;
		};
		if (result.device.id !== device.id)
			throw new Error("Invalid restored device receipt.");
	}
	async enroll(ownerToken: string, name: string) {
		const link = this.#link?.open ? this.#link : await this.#open();
		try {
			const keys = await crypto.subtle.generateKey(
				{ name: "ECDSA", namedCurve: "P-256" },
				false,
				["sign", "verify"],
			);
			const key = new Uint8Array(
				await crypto.subtle.exportKey("raw", keys.publicKey),
			);
			if (key.length !== 65 || key[0] !== 4 || keys.privateKey.extractable)
				throw new Error(
					"Could not create a non-extractable browser device key.",
				);
			const device = {
				publicKey: Array.from(key),
				privateKey: keys.privateKey,
			};
			const message = {
				type: "register_browser",
				pin: this.#pin,
				owner_token: ownerToken,
				name,
				...(await browserProof(link, device)),
			};
			let result: { type: string; device: Device };
			try {
				result = (await link.outcome(message, "device")) as typeof result;
			} finally {
				message.owner_token = "";
			}
			try {
				await saveDevice(this.key, { ...device, id: result.device.id });
				const saved = await loadDevice(this.key);
				if (!saved || saved.id !== result.device.id)
					throw new Error("Device key not stored.");
				this.#device = saved;
			} catch {
				throw new Error(
					"The server enrolled a device, but its key could not be saved securely. Revoke the orphaned device by name and ID before retrying.",
				);
			}
			if (!link.open) {
				this.#lost();
				throw lost();
			}
		} catch (error) {
			link.close();
			throw error;
		}
	}
	async forget() {
		const id = this.#device?.id;
		this.close();
		if (id) await removeDevice(this.key, id);
	}
	#run<T>(
		work: (link: NoiseLink) => Promise<T>,
		signal?: AbortSignal,
		mutation = false,
	): Promise<T> {
		if (this.signal.aborted) return Promise.reject(this.signal.reason);
		if (this.#waiting >= 64)
			return Promise.reject(
				new Error("The secure connection is busy. Try again shortly."),
			);
		this.#waiting++;
		const action = this.#tail
			.then(async () => {
				this.signal.throwIfAborted();
				signal?.throwIfAborted();
				const link = this.#link;
				if (!this.#device) throw new SessionExpired();
				if (!link?.open) {
					this.#lost();
					throw lost();
				}
				this.#mutating = mutation;
				try {
					const result = await work(link);
					this.signal.throwIfAborted();
					signal?.throwIfAborted();
					return result;
				} catch (error) {
					if (error instanceof NoiseError && error.code === "unauthorized") {
						const expired = new SessionExpired();
						const cleanup = this.forget();
						this.#onExpired?.(expired);
						await cleanup.catch(() => {});
						throw expired;
					}
					if (
						!(error instanceof NoiseError || error instanceof LocalFileError) &&
						error !== signal?.reason
					)
						this.#lost();
					throw error;
				} finally {
					this.#mutating = false;
				}
			})
			.finally(() => {
				this.#waiting--;
			});
		this.#tail = action.catch(() => {});
		// A closed generation rejects even requests behind a local file read that has not settled yet.
		return new Promise((resolve, reject) => {
			const abandon = () => reject(this.signal.reason);
			this.signal.addEventListener("abort", abandon, { once: true });
			void action
				.then(resolve, reject)
				.finally(() => this.signal.removeEventListener("abort", abandon));
		});
	}

	call<K extends keyof Commands>(
		type: K,
		fields: Commands[K][0],
		signal?: AbortSignal,
	) {
		return this.#run(
			async (link) =>
				(await link.outcome(
					{ ...fields, type },
					outcomes[type],
				)) as Commands[K][2],
			signal,
			!reads.has(type),
		);
	}
	async directory(signal?: AbortSignal): Promise<WorkspaceDirectory> {
		const channels = await pages(
			async (after) =>
				(
					await this.call(
						"categories",
						{ include_archived: true, after },
						signal,
					)
				).page,
		);
		const chats = await pages(
			async (after) =>
				(await this.call("threads", { include_archived: true, after }, signal))
					.page,
		);
		return {
			channels: channels.map((item) => ({
				...item,
				archived: flag(item.archived),
			})),
			chats: chats.map((item) => ({ ...item, archived: flag(item.archived) })),
		};
	}
	async history(chat: string, signal?: AbortSignal): Promise<Turn[]> {
		const turns = await pages(
			async (after) =>
				(await this.call("history", { chat, after }, signal)).page,
		);
		const full: Turn[] = [];
		for (const turn of turns) {
			const updates = await pages(
				async (after) =>
					(
						await this.call(
							"turn_updates",
							{ chat, turn: turn.id, after },
							signal,
						)
					).page,
			);
			full.push({ ...turn, updates });
		}
		return full;
	}
	async inbox(signal?: AbortSignal): Promise<InboxEvent[]> {
		return (
			await pages(
				async (after) => (await this.call("inbox", { after }, signal)).page,
			)
		).map((item) => ({ ...item, unread: flag(item.unread) }));
	}
	async profile(values?: ProfileValues, signal?: AbortSignal) {
		const profile = values ?? (await this.call("profile", {}, signal)).profile;
		const backends = await pages(
			async (after) =>
				(await this.call("profile_backends", { after }, signal)).page,
		);
		return { ...profile, backends };
	}
	async devices(signal?: AbortSignal) {
		const first = await this.call("devices", {}, signal);
		const devices = await pages(async (after) =>
			after === null
				? first.page
				: (await this.call("devices", { after }, signal)).page,
		);
		return { current: first.current, devices };
	}
	async updateIdentity(
		role: "owner" | "agent",
		input: Partial<Identity> | File,
	) {
		const { name, avatar } =
			input instanceof File
				? { avatar: (await this.upload(input, "avatar")).id }
				: input;
		const patch: IdentityPatch = {
			name,
			avatar:
				avatar === undefined
					? undefined
					: avatar === null
						? { type: "clear" }
						: { type: "set", id: avatar },
		};
		return this.profile(
			(await this.call("update_profile", { [role]: patch })).profile,
		);
	}
	async send(chat: string, draft: Draft) {
		const words = draft.text.trim().toLowerCase().split(/\s+/);
		if (isApprovalDraft(words[0])) {
			const choice = approvalChoice(words.join(" "));
			if (!choice || !draft.approval || draft.attachments?.length)
				throw new Error(
					"Choose an allowed action on a live approval. Nothing was approved.",
				);
			return this.call("decide_approval", { chat, id: draft.approval, choice });
		}
		return this.call("send_turn", { chat, message: message(draft) });
	}
	upload(file: File, purpose: "turn" | "avatar", signal?: AbortSignal) {
		if (file.size > (purpose === "avatar" ? 5 : 25) * MiB)
			return Promise.reject(new Error("File exceeds the transfer limit."));
		return this.#run(
			async (link) => {
				const cancel = async () => {
					control(
						await link.request({ type: "upload_cancel" }),
						"upload_cancelled",
					);
				};
				const checkAbort = async () => {
					if (!signal?.aborted) return;
					await cancel();
					throw signal.reason;
				};
				const init = {
					type: "upload",
					purpose,
					filename: file.name,
					size: file.size,
					mime: file.type || null,
				};
				control(await link.request(init), "upload_ready");
				for (
					let offset = 0, sequence = 0;
					offset < file.size;
					offset += chunkBytes, sequence++
				) {
					await checkAbort();
					const expected = Math.min(chunkBytes, file.size - offset);
					const bytes = await file
						.slice(offset, offset + expected)
						.arrayBuffer()
						.catch(() => null);
					await checkAbort();
					if (bytes?.byteLength !== expected) {
						await cancel();
						throw new LocalFileError("Could not read the complete local file.");
					}
					if (
						control(
							await link.chunk(sequence, new Uint8Array(bytes)),
							"upload_chunk_accepted",
						).sequence !== sequence
					)
						throw new Error("Invalid upload acknowledgement.");
				}
				await checkAbort();
				return control(
					await link.request({ type: "upload_finish" }),
					"upload_complete",
				).attachment;
			},
			signal,
			true,
		);
	}
	download(id: string, preview: boolean, signal: AbortSignal) {
		return this.#run(async (link) => {
			const cancel = async () => {
				control(
					await link.request({ type: "download_cancel" }),
					"download_cancelled",
				);
			};
			const checkAbort = async () => {
				if (!signal.aborted) return;
				await cancel();
				throw signal.reason;
			};
			const init = { type: "download", id };
			const { attachment } = control(
				await link.request(init),
				"download_start",
			);
			if (
				attachment.id !== id ||
				!Number.isSafeInteger(attachment.size) ||
				attachment.size < 0 ||
				attachment.size > 25 * MiB
			)
				throw new Error("Invalid attachment receipt.");
			if (preview && !mimeByKind[attachment.kind].has(attachment.mime)) {
				await cancel();
				return null;
			}
			const parts: Blob[] = [];
			for (
				let offset = 0, sequence = 0;
				offset < attachment.size;
				offset += chunkBytes, sequence++
			) {
				await checkAbort();
				const bytes = downloadChunk(
					await link.request({ type: "download_next" }),
					sequence,
					Math.min(chunkBytes, attachment.size - offset),
				);
				parts.push(new Blob([bytes]));
			}
			await checkAbort();
			control(
				await link.request({ type: "download_next" }),
				"download_complete",
			);
			return {
				attachment,
				blob: new Blob(parts, {
					type: preview ? attachment.mime : "application/octet-stream",
				}),
			};
		}, signal);
	}
}

export function message({ id, text, attachments }: Draft): Send {
	return { id, text, attachments };
}
export function approvalChoice(text: string): Choice | undefined {
	if (text === "/approve" || text === "/approve once") return "once";
	if (text === "/approve session") return "session";
	if (text === "/deny") return "deny";
}

export function isApprovalDraft(text: string) {
	const command = text.trimStart().split(/[@\s]/, 1)[0].toLowerCase();
	return command === "/approve" || command === "/deny";
}
