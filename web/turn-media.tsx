import {
	useEffect,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction,
} from "react";
import { type Attachment, upload } from "./chat.ts";
import { WorkspaceIcon } from "./workspace-icon.tsx";

type PendingFile = { key: string; file: File; item?: Attachment };
export type AttachmentDrafts = Record<string, PendingFile[]>;
export type SetAttachmentDrafts = Dispatch<SetStateAction<AttachmentDrafts>>;

export function attachmentDraft(
	drafts: AttachmentDrafts,
	setDrafts: SetAttachmentDrafts,
	key: string,
	server: string,
	report: (message: string) => void,
) {
	const entries = drafts[key] ?? [];
	const write = (change: (entries: PendingFile[]) => PendingFile[]) => {
		setDrafts((all) => ({ ...all, [key]: change(all[key] ?? []) }));
	};
	function add(files: FileList) {
		if (files.length + entries.length > 8) {
			report("Attach up to 8 files per message.");
			return;
		}
		if (Array.from(files).some((file) => file.size > 25 * 1024 * 1024)) {
			report("Each file can be up to 25 MiB.");
			return;
		}
		report("");
		const picked = Array.from(files, (file) => ({
			file,
			key: crypto.randomUUID(),
		}));
		write((list) => [...list, ...picked]);
		void (async () => {
			for (const entry of picked) {
				try {
					const item = await upload(entry.file, server, "turn");
					write((list) =>
						list.map((old) => (old.key === entry.key ? { ...old, item } : old)),
					);
				} catch (error) {
					write((list) => list.filter((old) => old.key !== entry.key));
					report(
						error instanceof Error ? error.message : "File upload failed.",
					);
				}
			}
		})();
	}
	return {
		entries,
		add,
		busy: entries.some((entry) => !entry.item),
		ids: entries.flatMap((entry) => (entry.item ? [entry.item.id] : [])),
		remove: (key: string) =>
			write((list) => list.filter((entry) => entry.key !== key)),
		clear: () =>
			write((list) =>
				list.filter((entry) => !entries.some((old) => old.key === entry.key)),
			),
	};
}

const names = { image: "Image", video: "Video", audio: "Audio", file: "File" };
function sizeLabel(size: number) {
	if (size < 1024) return `${size} B`;
	const unit = size < 1024 * 1024 ? 1024 : 1024 * 1024;
	return `${Number((size / unit).toFixed(1))} ${unit === 1024 ? "KiB" : "MiB"}`;
}
function MediaMeta({ item }: { item: Attachment }) {
	return (
		<div className="attachment-meta">
			<span className="attachment-badge">{names[item.kind]}</span>
			<span className="attachment-name">{item.filename}</span>
			<small className="attachment-size">{sizeLabel(item.size)}</small>
		</div>
	);
}
function MediaPreview({ item, source }: { item: Attachment; source: string }) {
	switch (item.kind) {
		case "image":
			return <img src={source} alt={item.filename} />;
		case "video":
			return (
				// biome-ignore lint/a11y/useMediaCaption: owner-supplied attachments may not have captions
				<video
					src={source}
					aria-label={item.filename}
					controls
					preload="metadata"
				/>
			);
		case "audio":
			return (
				// biome-ignore lint/a11y/useMediaCaption: owner-supplied attachments may not have captions
				<audio
					src={source}
					aria-label={item.filename}
					controls
					preload="metadata"
				/>
			);
		default:
			return null;
	}
}
function PendingPreview({ file, item }: { file: File; item: Attachment }) {
	const [source, setSource] = useState("");
	useEffect(() => {
		if (item.kind === "file") return;
		const url = URL.createObjectURL(file.slice(0, file.size, item.mime));
		setSource(url);
		return () => URL.revokeObjectURL(url);
	}, [file, item.kind, item.mime]);
	return source ? <MediaPreview item={item} source={source} /> : null;
}
export function AttachFiles({
	draft,
	disabled,
}: {
	draft: ReturnType<typeof attachmentDraft>;
	disabled: boolean;
}) {
	const picker = useRef<HTMLInputElement>(null);
	return (
		<>
			<input
				ref={picker}
				type="file"
				aria-label="Choose attachments"
				hidden
				multiple
				disabled={disabled || draft.busy || draft.entries.length >= 8}
				onChange={(event) => {
					if (event.currentTarget.files?.length)
						draft.add(event.currentTarget.files);
					event.currentTarget.value = "";
				}}
			/>
			<button
				className="quiet composer-icon-button has-tip tip-start"
				type="button"
				aria-label="Attach files"
				data-tip="Attach files"
				disabled={disabled || draft.busy || draft.entries.length >= 8}
				onClick={() => picker.current?.click()}
			>
				<WorkspaceIcon name="attach" />
			</button>
		</>
	);
}
export function PendingAttachments({
	draft,
	disabled,
}: {
	draft: ReturnType<typeof attachmentDraft>;
	disabled: boolean;
}) {
	if (!draft.entries.length) return null;
	return (
		<ul
			className="attachment-list pending-attachments"
			aria-label="Pending attachments"
		>
			{draft.entries.map(({ key, file, item }) => (
				<li key={key}>
					<div className="attachment-heading">
						{item ? (
							<MediaMeta item={item} />
						) : (
							<span className="attachment-name">Uploading {file.name}…</span>
						)}
						<button
							type="button"
							className="quiet"
							aria-label={`Remove ${file.name}`}
							disabled={disabled}
							onClick={() => draft.remove(key)}
						>
							<WorkspaceIcon name="close" />
						</button>
					</div>
					{item && <PendingPreview file={file} item={item} />}
				</li>
			))}
		</ul>
	);
}
export function SentAttachments({
	items,
	base,
}: {
	items: Attachment[];
	base: string;
}) {
	const [preview, setPreview] = useState<Attachment>();
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		if (preview) dialog.current?.showModal();
	}, [preview]);
	return (
		<>
			<ul
				className="attachment-list sent-attachments"
				aria-label="Message attachments"
			>
				{items.map((item) => {
					const source = `${base}/attachments/${item.id}`;
					return (
						<li key={item.id}>
							<div className="attachment-heading">
								<MediaMeta item={item} />
								<a
									href={`${source}/download`}
									download={item.filename}
									aria-label={`Download ${item.filename}`}
								>
									Download
								</a>
							</div>
							{item.kind === "image" ? (
								<button
									type="button"
									className="attachment-image quiet"
									aria-label={`Preview ${item.filename}`}
									onClick={() => setPreview(item)}
								>
									<MediaPreview item={item} source={source} />
								</button>
							) : (
								<MediaPreview item={item} source={source} />
							)}
						</li>
					);
				})}
			</ul>
			<dialog
				className="image-dialog"
				ref={dialog}
				aria-label={preview?.filename ?? "Image preview"}
				onClose={() => setPreview(undefined)}
			>
				{preview && (
					<>
						<div className="attachment-heading">
							<span className="attachment-name">{preview.filename}</span>
							<button
								type="button"
								className="quiet"
								onClick={() => dialog.current?.close()}
							>
								Close preview
							</button>
						</div>
						<img
							src={`${base}/attachments/${preview.id}`}
							alt={preview.filename}
						/>
					</>
				)}
			</dialog>
		</>
	);
}
