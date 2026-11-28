import * as codec from "#noise-codec";

export const chunkBytes = 32768;
const maxPacket = 65535;
const scratchBytes = 512 * 1024 + 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ErrorCode =
	| "unauthorized"
	| "invalid"
	| "busy"
	| "missing"
	| "conflict"
	| "limit"
	| "rate_limited"
	| "storage";
export class NoiseError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
	) {
		super(message);
	}
}
export class SessionExpired extends Error {
	constructor() {
		super("This device session expired or was revoked. Sign in again.");
	}
}
export type Attachment = {
	id: string;
	filename: string;
	mime: string;
	kind: "image" | "video" | "audio" | "file";
	size: number;
};
type Control =
	| {
			type:
				| "upload_ready"
				| "download_complete"
				| "upload_cancelled"
				| "download_cancelled";
	  }
	| { type: "upload_chunk_accepted"; sequence: number }
	| { type: "upload_complete" | "download_start"; attachment: Attachment }
	| { type: "error"; code: ErrorCode; message: string };
type Record =
	| { kind: "control"; value: Control }
	| { kind: "chunk"; sequence: number; bytes: Uint8Array<ArrayBuffer> }
	| { kind: "result"; value: { type: string } }
	| { kind: "part" };

function scratch() {
	const ptr = codec.scratch_ptr();
	return new Uint8Array(codec.memory.buffer, ptr, scratchBytes);
}
function exchange(input: Uint8Array, run: (length: number) => number) {
	if (input.length > scratchBytes) throw new Error("Noise record too large.");
	const temp = scratch();
	temp.set(input);
	let n = 0;
	try {
		n = run(input.length);
		if (n <= 0 || n > scratchBytes) throw new Error("Invalid Noise record.");
		return scratch().slice(0, n);
	} finally {
		scratch().fill(0, 0, Math.max(input.length, Math.min(n, scratchBytes)));
	}
}

const disconnected = () =>
	new Error(
		"The secure connection closed. A pending change may have committed; it was not retried.",
	);
export class NoiseLink {
	#id = 0;
	#wait?: {
		resolve: (bytes: Uint8Array) => void;
		reject: (error: Error) => void;
	};
	#openReject?: (error: Error) => void;
	#closed = false;
	onClosed?: () => void;
	private constructor(private readonly socket: WebSocket) {
		socket.binaryType = "arraybuffer";
		socket.onmessage = (event) => {
			const waiter = this.#wait;
			this.#wait = undefined;
			if (
				!waiter ||
				!(event.data instanceof ArrayBuffer) ||
				event.data.byteLength < 1 ||
				event.data.byteLength > maxPacket
			) {
				waiter?.reject(new Error("Invalid Noise packet."));
				this.close();
				return;
			}
			waiter.resolve(new Uint8Array(event.data));
		};
		socket.onerror = () => this.close();
		socket.onclose = () => this.close();
	}

	static async connect(path: string, pin: number[], signal?: AbortSignal) {
		if (
			!isSecureContext ||
			location.protocol !== "https:" ||
			!/^\/noise\/[a-z0-9-]{1,40}$/.test(path)
		)
			throw new Error("A trusted HTTPS workspace is required.");
		signal?.throwIfAborted();
		const url = new URL(path, location.origin);
		url.protocol = "wss:";
		const link = new NoiseLink(new WebSocket(url));
		const abort = () => link.close();
		signal?.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(abort, 5000);
		try {
			await new Promise<void>((resolve, reject) => {
				link.#openReject = reject;
				link.socket.onopen = () => {
					link.#openReject = undefined;
					resolve();
				};
			});
			const temp = scratch();
			temp.set(pin);
			link.#id = codec.start();
			if (!link.#id)
				throw new Error("Could not start Noise with secure randomness.");
			const reply = await link.#send(scratch().slice(0, 48));
			if (reply.length !== 48)
				throw new Error("The server did not prove the trusted Noise pin.");
			scratch().set(reply);
			if (codec.verify(link.#id, reply.length) !== 0)
				throw new Error(
					"The server did not prove the trusted Noise pin. Check it out of band.",
				);
			return link;
		} catch (error) {
			link.close();
			throw error;
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		}
	}

	get open() {
		return !this.#closed && this.socket.readyState === WebSocket.OPEN;
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#id) codec.close(this.#id);
		this.#id = 0;
		this.#wait?.reject(disconnected());
		this.#openReject?.(disconnected());
		this.#wait = undefined;
		this.#openReject = undefined;
		this.socket.close();
		this.onClosed?.();
	}

	#read() {
		if (!this.open || this.#wait) throw disconnected();
		return new Promise<Uint8Array>((resolve, reject) => {
			this.#wait = { resolve, reject };
		});
	}
	#send(bytes: Uint8Array<ArrayBuffer>) {
		if (this.socket.bufferedAmount > maxPacket)
			throw new Error("Noise send buffer is full.");
		const pending = this.#read();
		try {
			this.socket.send(bytes);
		} catch {
			this.close();
		}
		return pending;
	}
	#record(bytes: Uint8Array): Record {
		const plain = exchange(bytes, (n) => codec.response(this.#id, n));
		switch (plain[0]) {
			case 0:
				return {
					kind: "control",
					value: JSON.parse(decoder.decode(plain.subarray(1))),
				};
			case 1:
				return {
					kind: "chunk",
					sequence: new DataView(plain.buffer, 1, 4).getUint32(0),
					bytes: plain.slice(5),
				};
			case 2:
				return {
					kind: "result",
					value: JSON.parse(decoder.decode(plain.subarray(1))),
				};
			case 3:
				return { kind: "part" };
			default:
				throw new Error("Invalid Noise reply.");
		}
	}
	async request(message: { type: string }) {
		const bytes = encoder.encode(JSON.stringify(message));
		let packet: Uint8Array<ArrayBuffer>;
		try {
			packet = exchange(bytes, (n) => codec.request(this.#id, n));
		} finally {
			bytes.fill(0);
		}
		return this.#record(await this.#send(packet));
	}
	async chunk(sequence: number, bytes: Uint8Array<ArrayBuffer>) {
		const packet = exchange(bytes, (n) =>
			codec.upload_chunk(this.#id, n, sequence),
		);
		return this.#record(await this.#send(packet));
	}
	proof(registering: boolean, key: number[], id: string) {
		const bytes = Uint8Array.of(
			registering ? 1 : 0,
			...key,
			...encoder.encode(id),
		);
		return exchange(bytes, (n) => codec.proof(this.#id, n));
	}
	async outcome(message: { type: string }, expected: string) {
		let record = await this.request(message);
		while (record.kind === "part") record = this.#record(await this.#read());
		checkError(record);
		if (record.kind !== "result" || record.value.type !== expected)
			throw new Error("Unexpected Noise result.");
		return record.value;
	}
}

function checkError(record: Record) {
	if (record.kind === "control" && record.value.type === "error")
		throw new NoiseError(record.value.code, record.value.message);
}
export function control<T extends Exclude<Control["type"], "error">>(
	record: Record,
	type: T,
) {
	checkError(record);
	if (record.kind !== "control" || record.value.type !== type)
		throw new Error("Unexpected Noise transfer reply.");
	return record.value as Extract<Control, { type: T }> extends never
		? Control & { type: T }
		: Extract<Control, { type: T }>;
}
export function downloadChunk(record: Record, sequence: number, size: number) {
	checkError(record);
	if (
		record.kind !== "chunk" ||
		record.sequence !== sequence ||
		record.bytes.length !== size
	)
		throw new Error("Invalid Noise file chunk.");
	return record.bytes;
}
