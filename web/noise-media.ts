import { useEffect, useState } from "react";
import type { Attachment } from "./noise-link.ts";
import type { WorkspaceClient } from "./noise-workspace.ts";

type Asset = {
	users: number;
	bytes: number;
	url: string;
	abort: AbortController;
	result: Promise<string>;
};
const caches = new WeakMap<WorkspaceClient, Map<string, Asset>>();
const maxAssets = 16;
const maxBytes = 80 * 1024 * 1024;

function acquire(
	client: WorkspaceClient,
	id: string,
	kind: Attachment["kind"],
) {
	let cache = caches.get(client);
	if (!cache) {
		cache = new Map();
		caches.set(client, cache);
	}
	const key = `${kind}:${id}`;
	const asset = cache.get(key);
	if (asset) {
		asset.users++;
		return asset;
	}
	if (cache.size >= maxAssets) return;
	const abort = new AbortController();
	const entries = cache;
	const entry: Asset = {
		users: 1,
		bytes: 0,
		url: "",
		abort,
		result: Promise.resolve(""),
	};
	entry.result = (async () => {
		const file = await client.download(id, true, abort.signal);
		if (
			!file ||
			file.attachment.kind !== kind ||
			abort.signal.aborted ||
			client.signal.aborted
		)
			return "";
		const total = Array.from(entries.values()).reduce(
			(sum, item) => sum + item.bytes,
			0,
		);
		if (total + file.blob.size > maxBytes) return "";
		entry.bytes = file.blob.size;
		entry.url = URL.createObjectURL(file.blob);
		return entry.url;
	})().catch(() => "");
	cache.set(key, entry);
	return entry;
}
function release(
	client: WorkspaceClient,
	id: string,
	kind: Attachment["kind"],
	entry: Asset,
) {
	if (--entry.users > 0) return;
	entry.abort.abort();
	if (entry.url) URL.revokeObjectURL(entry.url);
	caches.get(client)?.delete(`${kind}:${id}`);
}

export function useMedia(
	client: WorkspaceClient,
	id: string | null | undefined,
	kind: Attachment["kind"],
) {
	const [value, setValue] = useState<{
		id: string;
		kind: Attachment["kind"];
		client: WorkspaceClient;
		url: string;
	}>();
	useEffect(() => {
		if (!id || client.signal.aborted || kind === "file") return;
		const asset = acquire(client, id, kind);
		if (!asset) return;
		let active = true;
		const dispose = () => {
			if (!active) return;
			active = false;
			release(client, id, kind, asset);
		};
		client.signal.addEventListener("abort", dispose, { once: true });
		void asset.result.then((url) => {
			if (active) setValue({ id, kind, client, url });
		});
		return () => {
			client.signal.removeEventListener("abort", dispose);
			dispose();
		};
	}, [client, id, kind]);
	return value &&
		!client.signal.aborted &&
		value.client === client &&
		value.id === id &&
		value.kind === kind
		? value.url
		: "";
}

export async function saveDownload(
	client: WorkspaceClient,
	id: string,
	signal: AbortSignal,
) {
	const file = await client.download(id, false, signal);
	if (!file || client.signal.aborted || signal.aborted) return;
	const href = URL.createObjectURL(file.blob);
	const release = () => {
		URL.revokeObjectURL(href);
		client.signal.removeEventListener("abort", release);
		clearTimeout(expire);
	};
	const expire = setTimeout(release, 2000);
	client.signal.addEventListener("abort", release, { once: true });
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.download = file.attachment.filename;
	anchor.click();
}
