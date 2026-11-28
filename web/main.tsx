import {
	configuredBackends,
	isApprovalDraft,
	message,
	selectionKey,
	WorkspaceClient,
	type Backend,
	type Choice,
	type Selection,
} from "./noise-workspace.ts";
import type { JSONContent } from "@tiptap/core";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type FormEvent,
	type FormEventHandler,
	type RefObject,
	type ReactNode,
} from "react";
import { ReplyBody, foreground, useBrowserAlerts } from "./reply-attention.tsx";
import {
	isPlainLinkClick,
	WorkspaceNav,
	WorkspaceRail,
} from "./workspace-nav.tsx";
import { WorkspaceIcon } from "./workspace-icon.tsx";
import { WorkspaceSearch } from "./workspace-search.tsx";
import {
	activeDirectory,
	ArchivePane,
	archivedThreadReason,
} from "./workspace-archive.tsx";
import { fallbackName, IdentityAvatar, ProfileSettings } from "./profile.tsx";
import {
	AttachFiles,
	PendingAttachments,
	SentAttachments,
	attachmentDraft,
	type AttachmentDrafts,
	type SetAttachmentDrafts,
} from "./turn-media.tsx";
import { createRoot } from "react-dom/client";
import {
	pending,
	replyDraft,
	requestFor,
	type Archived,
	type Chat,
	type Channel,
	type InboxEvent,
	type WorkspaceDirectory,
	type Profile,
	type Draft,
	type Turn,
	type TurnUpdate,
} from "./chat.ts";
import { Markdown } from "./markdown.tsx";
import {
	ComposerEditor,
	composerLimit,
	type ComposerEditorHandle,
} from "./composer-editor.tsx";
import "./app.css";

// Literal clipboard content stays local; requests contain only the serialized Markdown.
const literalClipboardDrafts = new WeakMap<Draft, JSONContent>();
function saveComposerDraft(
	drafts: Map<string, Draft>,
	key: string,
	draft: Draft,
	literalContent: JSONContent | undefined,
) {
	if (literalContent) literalClipboardDrafts.set(draft, literalContent);
	else literalClipboardDrafts.delete(draft);
	drafts.set(key, draft);
}
function literalDraft(draft: Draft | undefined) {
	return draft && literalClipboardDrafts.get(draft);
}

type Report = (message: string) => void;
function failure(e: unknown) {
	return e instanceof Error ? e.message : "Request failed.";
}
function useSubmit(report: Report) {
	const [busy, setBusy] = useState(false);
	const submitting = useRef(false);
	function submit(action: (form: HTMLFormElement) => Promise<void>) {
		return async (e: FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			if (submitting.current) return;
			submitting.current = true;
			setBusy(true);
			report("");
			const form = e.currentTarget;
			try {
				await action(form);
			} catch (e) {
				if (form.isConnected) report(failure(e));
			} finally {
				submitting.current = false;
				setBusy(false);
			}
		};
	}
	return { busy, submit };
}
const statuses = {
	queued: "Queued. Waiting to send to Hermes.",
	accepted: "Accepted by Hermes. No reply recorded yet.",
	reserved: "Saved locally. Admission not confirmed.",
	unknown: "Outcome unknown. Later messages in this thread will wait.",
	released: "Stopped waiting. The outcome of this turn is still unknown.",
	answered: "",
};
function Recovery({
	next,
	confirm,
	report,
}: {
	next?: string;
	confirm: () => Promise<void>;
	report: Report;
}) {
	const details = useRef<HTMLDetailsElement>(null);
	const summary = useRef<HTMLElement>(null);
	const preview = Array.from(next ?? "");
	const suffix = preview.length > 80 ? "…" : "";
	const { busy, submit } = useSubmit(report);
	return (
		<details className="recovery" ref={details}>
			<summary ref={summary}>Stop waiting and continue in this thread</summary>
			<form method="post" onSubmit={submit(confirm)}>
				<p>
					This stops waiting for this reply. It does not cancel or retry the old
					task, or approve any command.
				</p>
				{next ? (
					<p>
						When Hermes is available, queued messages will continue in order.
						Next:{" "}
						<q>
							{preview.slice(0, 80).join("")}
							{suffix}
						</q>
					</p>
				) : (
					<p>No messages are queued. You can send your next message here.</p>
				)}
				<div className="rename-actions">
					<button className="primary-action" type="submit" disabled={busy}>
						Confirm and continue
					</button>
					<button
						type="button"
						className="quiet"
						disabled={busy}
						onClick={() => {
							if (details.current) details.current.open = false;
							summary.current?.focus();
						}}
					>
						Cancel
					</button>
				</div>
			</form>
		</details>
	);
}
function ActivityList({
	updates,
	agentName,
	agentAvatar,
	mediaClient,
	decide,
}: {
	updates: TurnUpdate[];
	agentName: string;
	agentAvatar?: string | null;
	mediaClient: WorkspaceClient;
	decide?: (id: string, choice: Choice) => void;
}) {
	return (
		<div className="activity-list">
			{updates.map((u) => {
				if (u.kind === "progress" || u.choices?.length)
					return (
						<div key={u.id}>
							<pre
								className={
									u.choices?.length
										? "progress-log approval-prompt"
										: "progress-log"
								}
							>
								{u.text}
							</pre>
							{decide && u.choices && (
								<div className="approval-actions">
									{u.choices.map((c) => (
										<button
											type="button"
											key={c}
											className={c === "deny" ? "danger-action" : undefined}
											onClick={() => decide(u.id, c)}
										>
											{
												{
													deny: "Deny",
													session: "Approve for session",
													once: "Approve once",
												}[c]
											}
										</button>
									))}
								</div>
							)}
						</div>
					);
				return (
					<div key={u.id} className="interim-note">
						<p className="interim-label">
							<IdentityAvatar
								identity="agent"
								id={agentAvatar}
								base={mediaClient}
							/>
							{agentName} · update
						</p>
						<Markdown text={u.text} />
					</div>
				);
			})}
		</div>
	);
}
type ThreadEditForm = {
	busy: boolean;
	change: (value: string) => void;
	close: () => void;
	save: FormEventHandler<HTMLFormElement>;
};

function RenameThreadForm({
	draft,
	input,
	busy,
	change,
	close,
	save,
}: ThreadEditForm & {
	draft: string;
	input: RefObject<HTMLInputElement | null>;
}) {
	const value = draft.trim();
	return (
		<form method="post" onSubmit={save}>
			<label htmlFor="thread-title">Thread title (1–80 characters)</label>
			<input
				ref={input}
				id="thread-title"
				value={draft}
				required
				disabled={busy}
				onChange={(e) => change(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape" && !e.nativeEvent.isComposing) close();
				}}
			/>
			<div className="rename-actions">
				<button
					className="primary-action"
					type="submit"
					disabled={busy || !value || [...value].length > 80}
				>
					Save title
				</button>
				<button type="button" className="quiet" disabled={busy} onClick={close}>
					Cancel
				</button>
			</div>
		</form>
	);
}

function MoveThreadForm({
	destination,
	current,
	channels,
	select,
	busy,
	change,
	close,
	save,
}: ThreadEditForm & {
	destination: string;
	current: string;
	channels: Channel[];
	select: RefObject<HTMLSelectElement | null>;
}) {
	return (
		<form
			method="post"
			onSubmit={save}
			onKeyDown={(event) => {
				if (!busy && event.key === "Escape" && !event.nativeEvent.isComposing) {
					event.preventDefault();
					close();
				}
			}}
		>
			<label htmlFor="move-category">Move to category</label>
			<select
				id="move-category"
				ref={select}
				value={destination}
				disabled={busy}
				onChange={(event) => change(event.currentTarget.value)}
			>
				{channels.map((item) => (
					<option key={item.id} value={item.id}>
						{item.name}
					</option>
				))}
			</select>
			<div className="rename-actions">
				<button
					className="primary-action"
					type="submit"
					disabled={busy || destination === current}
				>
					Move
				</button>
				<button className="quiet" type="button" disabled={busy} onClick={close}>
					Cancel
				</button>
			</div>
		</form>
	);
}

function ThreadTitle({
	title,
	channel,
	channels,
	markRead,
	rename,
	move,
	archive,
	archived,
	archiveReason,
	report,
}: {
	title: string;
	channel: Channel;
	channels: Channel[];
	move: (channel: string) => Promise<void>;
	archive: (archived: boolean) => Promise<void>;
	archived: Archived;
	archiveReason: string;
	markRead?: () => void;
	rename: (title: string) => Promise<void>;
	report: Report;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const [destination, setDestination] = useState<string | null>(null);
	const moveTrigger = useRef<HTMLButtonElement>(null);
	const moveSelect = useRef<HTMLSelectElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const { busy, submit } = useSubmit(report);
	const editing = draft !== null;
	useEffect(() => {
		if (editing) input.current?.select();
	}, [editing]);
	const moving = destination !== null;
	useEffect(() => {
		if (moving) moveSelect.current?.focus();
	}, [moving]);
	function closeMove() {
		setDestination(null);
		moveTrigger.current?.focus();
	}
	function close() {
		setDraft(null);
		trigger.current?.focus();
	}
	return (
		<>
			<div className="thread-bar">
				<a
					className="thread-back quiet"
					href={`#channel/${channel.id}`}
					aria-label={`Back to ${channel.name}`}
				>
					<WorkspaceIcon name="back" />
				</a>
				<span className="thread-kicker">Thread</span>
				<form
					className="thread-archive"
					method="post"
					onSubmit={submit(async () => {
						await archive(!archived);
						setDestination(null);
					})}
				>
					<button className="quiet" type="submit" aria-disabled={busy}>
						{archived ? "Restore thread" : "Archive thread"}
					</button>
				</form>
			</div>
			<h1 id="thread-heading" tabIndex={-1}>
				{title}
			</h1>
			<div className="thread-tools">
				<button
					ref={trigger}
					className="quiet"
					type="button"
					aria-expanded={editing}
					aria-disabled={busy}
					onClick={() => {
						if (busy) return;
						if (editing) close();
						else {
							setDestination(null);
							setDraft(title);
						}
					}}
				>
					Rename thread
				</button>
				{!archiveReason && (
					<button
						ref={moveTrigger}
						className="quiet"
						type="button"
						aria-expanded={moving}
						aria-disabled={busy}
						onClick={() => {
							if (busy) return;
							if (moving) closeMove();
							else {
								setDraft(null);
								setDestination(channel.id);
							}
						}}
					>
						Move thread
					</button>
				)}
				{markRead && (
					<button className="quiet" type="button" onClick={markRead}>
						Mark thread read
					</button>
				)}
			</div>
			{draft !== null && (
				<RenameThreadForm
					draft={draft}
					busy={busy}
					input={input}
					change={setDraft}
					close={close}
					save={submit(async () => {
						await rename(draft.trim());
						close();
					})}
				/>
			)}
			{!archiveReason && destination !== null && (
				<MoveThreadForm
					destination={destination}
					current={channel.id}
					channels={channels}
					busy={busy}
					select={moveSelect}
					change={setDestination}
					close={closeMove}
					save={submit(async () => {
						await move(destination);
						closeMove();
					})}
				/>
			)}
		</>
	);
}
type ConversationProps = {
	chat: Chat;
	channel: Channel;
	channels: Channel[];
	profile: Profile | undefined;
	mediaClient: WorkspaceClient;
	attachmentDrafts: AttachmentDrafts;
	setAttachmentDrafts: SetAttachmentDrafts;
	move: (channel: string) => Promise<void>;
	archive: (archived: boolean) => Promise<void>;
	markRead?: () => void;
	events: InboxEvent[];
	alerts: ReturnType<typeof useBrowserAlerts>;
	onRead: (id: string, chat: string) => Promise<boolean>;
	drawerOpen: boolean;
	server: WorkspaceClient;
	report: Report;
	drafts: Map<string, Draft>;
	rename: (title: string) => Promise<void>;
};
type ThreadAlerts = ReturnType<typeof useBrowserAlerts>;

function useConversationHistory(
	chat: string,
	server: WorkspaceClient,
	report: Report,
	newest?: string,
) {
	const [turns, setTurns] = useState<Turn[] | null>(null);
	const [revision, reload] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: each successful POST invalidates the current history revision
	useEffect(() => {
		const controller = new AbortController();
		let timer: number | undefined;
		let reading = false;
		let unsettled = true;
		const active = () => !controller.signal.aborted && !server.signal.aborted;
		async function read() {
			if (reading || !active()) return;
			reading = true;
			try {
				const rows = await server.history(chat, controller.signal);
				if (!active()) return;
				unsettled = pending(rows);
				setTurns(rows);
			} catch (e) {
				if (active()) report(failure(e));
			} finally {
				reading = false;
				// A Native enqueue or another browser's turn can change an otherwise settled
				// thread without producing an Inbox event. Only poll settled foreground detail.
				if (active() && (unsettled || document.visibilityState === "visible"))
					timer = window.setTimeout(read, unsettled ? 1500 : 4500);
			}
		}
		function onVisibility() {
			if (document.visibilityState === "visible") {
				clearTimeout(timer);
				void read();
			} else if (!unsettled) clearTimeout(timer);
		}
		document.addEventListener("visibilitychange", onVisibility);
		void read();
		return () => {
			controller.abort();
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [chat, server, report, revision, newest]);
	return { turns, invalidate: () => reload((n) => n + 1) };
}

function sendableDraft(
	text: string,
	files: ReturnType<typeof attachmentDraft>,
) {
	return (
		!files.busy &&
		text.length <= composerLimit &&
		(Boolean(text.trim()) || files.ids.length > 0)
	);
}

function ComposerActions({
	files,
	busy,
	blocked,
	limit,
	formatToggle,
	mode,
}: {
	files: ReturnType<typeof attachmentDraft>;
	busy: boolean;
	blocked: boolean;
	limit: ReactNode;
	formatToggle: ReactNode;
	mode: "reply" | "start";
}) {
	const label = mode === "reply" ? "Send message" : "Start thread";
	return (
		<>
			<PendingAttachments draft={files} disabled={busy} />
			<div className="composer-actions">
				<div className="composer-tools">
					<AttachFiles draft={files} disabled={blocked} />
					{formatToggle}
				</div>
				{limit}
				<button
					className="primary-action composer-submit has-tip tip-end"
					type="submit"
					aria-label={label}
					data-tip={label}
					disabled={blocked || files.busy}
				>
					<WorkspaceIcon name={mode === "reply" ? "send" : "plus"} />
				</button>
			</div>
		</>
	);
}

function ReplyComposer({
	chat,
	server,
	drafts,
	turns,
	attachmentDrafts,
	setAttachmentDrafts,
	report,
	sent,
}: Pick<
	ConversationProps,
	| "chat"
	| "server"
	| "drafts"
	| "attachmentDrafts"
	| "setAttachmentDrafts"
	| "report"
> & {
	turns: Turn[] | null;
	sent: () => void;
}) {
	const editor = useRef<ComposerEditorHandle>(null);
	const { busy, submit } = useSubmit(report);
	const files = attachmentDraft(
		attachmentDrafts,
		setAttachmentDrafts,
		chat.id,
		server,
		report,
	);
	const blocked = !turns || busy;
	return (
		<form
			id="compose"
			method="post"
			onSubmit={submit(async (form) => {
				const text = drafts.get(chat.id)?.text ?? "";
				if (blocked || !sendableDraft(text, files)) return;
				const draft = requestFor(text, drafts.get(chat.id) ?? null, files.ids);
				saveComposerDraft(
					drafts,
					chat.id,
					draft,
					literalDraft(drafts.get(chat.id)),
				);
				await server.send(chat.id, draft);
				// A reopened composer may still hold this draft. Leave the entire request
				// intact so its explicit retry keeps the same ID and attachments.
				if (!form.isConnected || drafts.get(chat.id) !== draft) return;
				drafts.delete(chat.id);
				files.clear();
				editor.current?.clear();
				sent();
			})}
		>
			<ComposerEditor
				id="text"
				ref={editor}
				server={server}
				canSuggestApproval={(choice) => {
					const approval = drafts.get(chat.id)?.approval;
					return Boolean(
						approval &&
							turns?.some((turn) =>
								turn.updates.some(
									(item) =>
										item.id === approval && item.choices?.includes(choice),
								),
							),
					);
				}}
				label="Your message"
				placeholder="Write a reply…"
				initialMarkdown={drafts.get(chat.id)?.text ?? ""}
				initialLiteralContent={literalDraft(drafts.get(chat.id))}
				onMarkdownChange={(value, literalContent) => {
					if (value)
						saveComposerDraft(
							drafts,
							chat.id,
							replyDraft(value, drafts.get(chat.id) ?? null, turns ?? []),
							literalContent,
						);
					else drafts.delete(chat.id);
				}}
				blocked={blocked}
				hasAttachments={files.ids.length > 0}
				actions={(limit, formatToggle) => (
					<ComposerActions
						files={files}
						busy={busy}
						blocked={blocked}
						limit={limit}
						formatToggle={formatToggle}
						mode="reply"
					/>
				)}
			/>
		</form>
	);
}

type TurnActions = {
	decide: (id: string, choice: Choice) => Promise<void>;
	stopWaiting: (id: string) => Promise<void>;
};

function PendingTurn({
	turn,
	stopWaiting,
	report,
	next,
}: Pick<TurnActions, "stopWaiting"> & {
	turn: Turn;
	report: Report;
	next?: string;
}) {
	const working = turn.state === "accepted" && turn.updates.length > 0;
	return (
		<>
			<p className="status-line" data-state={turn.state}>
				<small>
					{working ? "Accepted by Hermes. Working…" : statuses[turn.state]}
				</small>
			</p>
			{turn.state === "unknown" && (
				<Recovery
					next={next}
					report={report}
					confirm={() => stopWaiting(turn.id)}
				/>
			)}
		</>
	);
}

function TurnActivity({
	turn,
	profile,
	mediaClient,
	decide,
}: {
	turn: Turn;
	profile: Profile | undefined;
	mediaClient: WorkspaceClient;
	decide: TurnActions["decide"];
}) {
	if (!turn.updates.length) return null;
	const agentName = profile?.agent.name || fallbackName.agent;
	const activity = (
		<ActivityList
			updates={turn.updates}
			agentName={agentName}
			agentAvatar={profile?.agent.avatar}
			mediaClient={mediaClient}
			decide={turn.answer === null ? decide : undefined}
		/>
	);
	if (turn.answer === null) return activity;
	const label = turn.updates.length === 1 ? "update" : "updates";
	return (
		<details className="activity-details">
			<summary>
				Activity ({turn.updates.length} {label})
			</summary>
			{activity}
		</details>
	);
}

function OwnerTurn({
	turn,
	profile,
	mediaClient,
	report,
}: {
	turn: Turn;
	profile?: Profile;
	mediaClient: WorkspaceClient;
	report: Report;
}) {
	if (!turn.text && !turn.attachments?.length) return null;
	return (
		<div className="user-turn">
			<IdentityAvatar
				identity="owner"
				id={profile?.owner.avatar}
				base={mediaClient}
			/>
			<p className="speaker">{profile?.owner.name || fallbackName.owner}</p>
			{turn.text && <p className="message">{turn.text}</p>}
			{turn.attachments && (
				<SentAttachments
					items={turn.attachments}
					base={mediaClient}
					report={report}
				/>
			)}
		</div>
	);
}

type TurnTimelineProps = Pick<
	ConversationProps,
	| "chat"
	| "profile"
	| "mediaClient"
	| "events"
	| "alerts"
	| "drawerOpen"
	| "onRead"
	| "report"
>;

function TurnArticle({
	turn,
	workspace,
	actions,
	next,
}: {
	turn: Turn;
	workspace: TurnTimelineProps;
	actions: TurnActions;
	next?: string;
}) {
	const {
		chat,
		profile,
		mediaClient,
		events,
		alerts,
		drawerOpen,
		onRead,
		report,
	} = workspace;
	const answered = turn.answer !== null;
	const delivered = answered && !turn.text && !turn.attachments?.length;
	return (
		<article className="turn">
			<OwnerTurn
				turn={turn}
				profile={profile}
				mediaClient={mediaClient}
				report={report}
			/>
			<div className="assistant-turn">
				<IdentityAvatar
					identity="agent"
					id={profile?.agent.avatar}
					base={mediaClient}
				/>
				<p className="speaker">
					{profile?.agent.name || fallbackName.agent}
					{answered && turn.state === "released" && (
						<span className="push-tag">
							Late reply after you stopped waiting
						</span>
					)}
					{delivered && <span className="push-tag">Delivered</span>}
				</p>
				<TurnActivity
					turn={turn}
					profile={profile}
					mediaClient={mediaClient}
					decide={actions.decide}
				/>
				{turn.answer === null ? (
					<PendingTurn
						turn={turn}
						stopWaiting={actions.stopWaiting}
						report={report}
						next={next}
					/>
				) : (
					<ReplyBody
						text={turn.answer}
						id={turn.id}
						chat={chat.id}
						read={
							!events.some((event) => event.request === turn.id && event.unread)
						}
						alert={alerts.fresh.current.has(turn.id)}
						drawerOpen={drawerOpen}
						onRead={onRead}
						notify={alerts.notify}
					/>
				)}
			</div>
		</article>
	);
}

function TurnTimeline({
	turns,
	follow,
	workspace,
	actions,
}: {
	turns: Turn[] | null;
	follow: RefObject<boolean>;
	workspace: TurnTimelineProps;
	actions: TurnActions;
}) {
	const timeline = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = timeline.current;
		if (el && turns && follow.current) el.scrollTop = el.scrollHeight;
	}, [turns, follow]);
	const queued = turns?.find((row) => row.state === "queued")?.text;
	return (
		<div
			id="turns"
			ref={timeline}
			onScroll={(event) => {
				const el = event.currentTarget;
				follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
			}}
		>
			{turns?.length === 0 && (
				<p className="empty">
					This thread is ready. Send a message when you want Hermes to begin.
				</p>
			)}
			{turns?.map((turn) => (
				<TurnArticle
					key={turn.id}
					turn={turn}
					workspace={workspace}
					actions={actions}
					next={queued}
				/>
			))}
		</div>
	);
}

function threadActions(
	chat: string,
	server: WorkspaceClient,
	report: Report,
	invalidate: () => void,
): TurnActions {
	return {
		async decide(approval, choice) {
			try {
				await server.call("decide_approval", { chat, id: approval, choice });
				invalidate();
			} catch (error) {
				report(failure(error));
			}
		},
		async stopWaiting(id) {
			try {
				await server.call("release_turn", { chat, id });
			} finally {
				invalidate();
			}
		},
	};
}

function Conversation(props: ConversationProps) {
	const {
		chat,
		channel,
		channels,
		move,
		archive,
		markRead,
		rename,
		report,
		server,
		events,
	} = props;
	const archiveReason = archivedThreadReason(chat, channel);
	const { turns, invalidate } = useConversationHistory(
		chat.id,
		server,
		report,
		events[0]?.request,
	);
	const follow = useRef(true);
	return (
		<section className="conversation" aria-labelledby="thread-heading">
			<div className="pane-head">
				<ThreadTitle
					title={chat.title}
					channel={channel}
					channels={channels}
					move={move}
					archive={archive}
					archived={chat.archived}
					archiveReason={archiveReason}
					markRead={markRead}
					rename={rename}
					report={report}
				/>
			</div>
			<TurnTimeline
				turns={turns}
				follow={follow}
				workspace={props}
				actions={threadActions(chat.id, server, report, invalidate)}
			/>
			{archiveReason ? (
				<p className="archive-notice" role="status">
					{archiveReason}
				</p>
			) : (
				<ReplyComposer
					{...props}
					turns={turns}
					sent={() => {
						follow.current = true;
						invalidate();
					}}
				/>
			)}
		</section>
	);
}
type ThreadOpener = { id: string; trigger?: HTMLElement };
type WorkspaceRoot = RefObject<HTMLDivElement | null>;
type WorkspaceProps = {
	server: WorkspaceClient;
	mediaClient: WorkspaceClient;
	attachmentDrafts: AttachmentDrafts;
	setAttachmentDrafts: SetAttachmentDrafts;
	report: Report;
	expire: Report;
	changeServer: () => void;
	drafts: Map<string, Draft>;
};

function useWorkspaceDirectory(server: WorkspaceClient, report: Report) {
	const [directory, setDirectory] = useState<WorkspaceDirectory>({
		channels: [],
		chats: [],
	});
	const revision = useRef(0);
	useEffect(() => {
		let active = true;
		let timer: number;
		async function refresh() {
			const started = revision.current;
			try {
				const value = await server.directory();
				if (active && revision.current === started) setDirectory(value);
			} catch (e) {
				if (active) report(failure(e));
			} finally {
				if (active) timer = window.setTimeout(refresh, 4000);
			}
		}
		void refresh();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [server, report]);
	function recordThread(thread: Omit<Chat, "archived">) {
		revision.current += 1;
		setDirectory((old) => {
			const existing = old.chats.find((chat) => chat.id === thread.id);
			return {
				...old,
				chats: [
					{ archived: existing?.archived ?? 0, ...thread },
					...old.chats.filter((chat) => chat.id !== thread.id),
				],
			};
		});
	}
	function recordCategory(channel: Omit<Channel, "archived">) {
		revision.current += 1;
		setDirectory((old) => ({
			...old,
			channels: [...old.channels, { ...channel, archived: 0 }],
		}));
	}
	function updateThread(id: string, patch: Partial<Chat>) {
		revision.current += 1;
		setDirectory((old) => ({
			...old,
			chats: old.chats.map((chat) =>
				chat.id === id ? { ...chat, ...patch } : chat,
			),
		}));
	}
	function updateCategory(id: string, patch: Partial<Channel>) {
		revision.current += 1;
		setDirectory((old) => ({
			...old,
			channels: old.channels.map((channel) =>
				channel.id === id ? { ...channel, ...patch } : channel,
			),
		}));
	}
	return {
		...directory,
		recordThread,
		recordCategory,
		updateThread,
		updateCategory,
	};
}
type Directory = ReturnType<typeof useWorkspaceDirectory>;

function useWorkspaceProfile(
	server: WorkspaceClient,
	report: Report,
	settings: boolean,
) {
	const [profile, setProfile] = useState<Profile>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: opening Settings also refreshes discoverable backends
	useEffect(() => {
		let active = true;
		void server.profile().then(
			(value) => {
				if (active) setProfile(value);
			},
			(error) => {
				if (active) report(failure(error));
			},
		);
		return () => {
			active = false;
		};
	}, [server, report, settings]);
	return { profile, setProfile };
}

function useWorkspaceInbox(
	server: WorkspaceClient,
	report: Report,
	alerts: ThreadAlerts,
) {
	const [events, setEvents] = useState<InboxEvent[] | null>(null);
	const [revision, refresh] = useState(0);
	const { capture, fresh } = alerts;
	// biome-ignore lint/correctness/useExhaustiveDependencies: explicit reads invalidate the inbox revision
	useEffect(() => {
		let active = true;
		let timer: number;
		async function poll() {
			try {
				const rows = await server.inbox();
				if (active) {
					capture(rows);
					setEvents(rows);
				}
			} catch (e) {
				if (active) {
					report(failure(e));
				}
			} finally {
				if (active) timer = window.setTimeout(poll, 4000);
			}
		}
		void poll();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [server, report, revision, capture]);
	const onRead = useCallback(
		async (id: string, chat: string) => {
			try {
				await server.call("read_reply", { chat, id });
				fresh.current.delete(id);
				setEvents(
					(rows) =>
						rows?.map((e) =>
							e.chat === chat && e.request === id ? { ...e, unread: 0 } : e,
						) ?? null,
				);
				refresh((n) => n + 1);
				return true;
			} catch (e) {
				report(failure(e));
				return false;
			}
		},
		[server, report, fresh],
	);
	async function markRead(id: string) {
		try {
			await server.call("read_thread", { chat: id });
			refresh((n) => n + 1);
		} catch (e) {
			report(failure(e));
		}
	}
	function moveEvents(chat: string, channel: string) {
		setEvents(
			(list) =>
				list?.map((event) =>
					event.chat === chat ? { ...event, channel } : event,
				) ?? null,
		);
		refresh((n) => n + 1);
	}
	return { events, onRead, markRead, moveEvents };
}
type InboxState = ReturnType<typeof useWorkspaceInbox>;

function useBackgroundAlerts(
	events: InboxState["events"],
	selected: string,
	obscured: boolean,
	notify: ThreadAlerts["notify"],
) {
	// For the open conversation, let its rendered reply decide whether it is in view.
	useEffect(() => {
		for (const e of events ?? []) {
			if (e.unread && (e.chat !== selected || obscured || !foreground()))
				notify(e.request, e.chat);
		}
	}, [events, selected, obscured, notify]);
}

function unreadCounts(events: InboxState["events"]) {
	const unread = new Map<string, number>();
	let total = 0;
	for (const event of events ?? []) {
		if (event.unread) unread.set(event.chat, (unread.get(event.chat) ?? 0) + 1);
		total += event.unread;
	}
	return { unread, total };
}

function restoreCategoryScroll(
	feed: HTMLElement,
	position: { id: string; scrollTop: number } | null,
	category: string | undefined,
) {
	if (position && position.id === category) feed.scrollTop = position.scrollTop;
}

function canRestoreCategory(
	category: string | undefined,
	previous: { category: string; placement: string } | null,
) {
	return (
		previous !== null &&
		(category === previous.category || category === previous.placement)
	);
}

function rowInScrollport(row: HTMLElement, feed: HTMLElement) {
	const bounds = row.getBoundingClientRect();
	const scrollport = feed.getBoundingClientRect();
	return bounds.top >= scrollport.top && bounds.bottom <= scrollport.bottom;
}

function focusCategoryReturn(
	feed: HTMLDivElement,
	heading: HTMLElement | null,
	opening: ThreadOpener | null,
) {
	const trigger = opening?.trigger;
	if (trigger?.isConnected && trigger.getClientRects().length) {
		trigger.focus({ preventScroll: true });
		return;
	}
	// A category row opener remounts on return; find it by its thread ID.
	if (opening && !trigger) {
		const row = feed.querySelector<HTMLAnchorElement>(
			`a[href="#${CSS.escape(opening.id)}"]`,
		);
		if (row && rowInScrollport(row, feed)) {
			row.focus({ preventScroll: true });
			return;
		}
	}
	heading?.focus({ preventScroll: true });
}

function useCategoryHistory(workspace: WorkspaceRoot, report: Report) {
	const [selected, select] = useState(location.hash.slice(1));
	const categoryFeed = useRef<HTMLDivElement>(null);
	const categoryPosition = useRef<{ id: string; scrollTop: number } | null>(
		null,
	);
	const navigationRevision = useRef(0);
	const navigationSourceCategory = useRef<string | null>(null);
	const focusFirstMessage = useRef<string | null>(null);
	useEffect(() => {
		const navigate = () => {
			navigationRevision.current += 1;
			const feed = categoryFeed.current;
			navigationSourceCategory.current = feed?.dataset.category ?? null;
			if (feed?.dataset.category) {
				categoryPosition.current = {
					id: feed.dataset.category,
					scrollTop: feed.scrollTop,
				};
			}
			report("");
			select(location.hash.slice(1));
		};
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, [report]);
	function focusComposer() {
		workspace.current?.querySelector<HTMLElement>("#first-message")?.focus();
	}
	function startThread(id: string) {
		if (selected === `channel/${id}`) focusComposer();
		else focusFirstMessage.current = id;
	}
	return {
		selected,
		categoryFeed,
		categoryPosition,
		navigationRevision,
		navigationSourceCategory,
		focusFirstMessage,
		startThread,
	};
}
type CategoryHistory = ReturnType<typeof useCategoryHistory>;

function useThreadFocus(
	workspace: WorkspaceRoot,
	history: CategoryHistory,
	threadId?: string,
	categoryId?: string,
) {
	const { selected, categoryFeed, categoryPosition, navigationSourceCategory } =
		history;
	const threadOpener = useRef<ThreadOpener | null>(null);
	const previousThread = useRef<{
		id: string;
		category: string;
		placement: string;
		opener: ThreadOpener | null;
	} | null>(null);
	const explicitCategory = useRef<string | null>(null);
	const categoryHeading = useRef<HTMLHeadingElement>(null);
	useLayoutEffect(() => {
		const previous = previousThread.current;
		const placed = threadId && categoryId;
		// Moving changes the visible placement, not the history entry that opened this thread.
		if (placed && previous?.id === threadId) {
			previous.placement = categoryId;
			return;
		}
		const explicit = explicitCategory.current;
		previousThread.current = null;
		explicitCategory.current = null;
		if (placed) {
			const opening = threadOpener.current;
			threadOpener.current = null;
			previousThread.current = {
				id: threadId,
				category: navigationSourceCategory.current ?? categoryId,
				placement: categoryId,
				opener: opening?.id === threadId ? opening : null,
			};
			workspace.current
				?.querySelector<HTMLElement>("#thread-heading")
				?.focus({ preventScroll: true });
			return;
		}
		const feed = categoryFeed.current;
		if (!previous || !feed || !canRestoreCategory(categoryId, previous)) return;
		restoreCategoryScroll(feed, categoryPosition.current, categoryId);
		if (explicit !== categoryId)
			focusCategoryReturn(feed, categoryHeading.current, previous.opener);
	}, [
		threadId,
		categoryId,
		workspace,
		categoryFeed,
		categoryPosition,
		navigationSourceCategory,
	]);
	function rememberThreadOpener(thread: Chat, trigger?: HTMLElement) {
		if (thread.id !== selected)
			threadOpener.current = { id: thread.id, trigger };
	}
	function onDesktopCategoryOpen(id: string) {
		if (threadId && id === categoryId) explicitCategory.current = id;
	}
	return { categoryHeading, rememberThreadOpener, onDesktopCategoryOpen };
}

function useFirstMessageFocus(
	workspace: WorkspaceRoot,
	history: CategoryHistory,
) {
	const { selected, focusFirstMessage } = history;
	useLayoutEffect(() => {
		if (
			focusFirstMessage.current &&
			selected === `channel/${focusFirstMessage.current}`
		) {
			focusFirstMessage.current = null;
			workspace.current?.querySelector<HTMLElement>("#first-message")?.focus();
		}
	}, [selected, workspace, focusFirstMessage]);
}

function workspaceRoute(directory: Directory, selected: string) {
	const chat = directory.chats.find((item) => item.id === selected);
	const channelId =
		chat?.channel ??
		(selected ? selected.replace(/^channel\//, "") : "general");
	const channel = directory.channels.find((item) => item.id === channelId);
	const inbox = selected === "inbox";
	const settings = selected === "settings";
	const archive = selected === "archive";
	const threadId = !inbox && !settings && !archive ? chat?.id : undefined;
	return { chat, channel, inbox, settings, archive, threadId };
}
type WorkspaceRoute = ReturnType<typeof workspaceRoute>;

function WorkspaceCommandBar({
	route,
	directory,
	setSearchOpen,
	rememberThreadOpener,
}: {
	route: WorkspaceRoute;
	directory: Directory;
	setSearchOpen: (open: boolean) => void;
	rememberThreadOpener: (thread: Chat, trigger: HTMLElement) => void;
}) {
	const { inbox, settings, archive, channel, chat } = route;
	const { channels, chats } = activeDirectory(directory);
	return (
		<div className="command-bar">
			<nav className="workspace-path" aria-label="Breadcrumb">
				{settings && <span aria-current="page">Settings</span>}
				{inbox && <span aria-current="page">Inbox</span>}
				{archive && <span aria-current="page">Archived</span>}
				{channel && !chat && (
					<span aria-current="page" title={channel.name}>
						{channel.name}
					</span>
				)}
				{channel && chat && (
					<>
						<a
							href={`#channel/${channel.id}`}
							aria-label={`Category: ${channel.name}`}
							title={channel.name}
						>
							{channel.name}
						</a>
						<span className="path-arrow" aria-hidden="true">
							→
						</span>
						<span aria-current="page" title={chat.title}>
							{chat.title}
						</span>
					</>
				)}
			</nav>
			<WorkspaceSearch
				channels={channels}
				chats={chats}
				setOpen={setSearchOpen}
				onThreadOpen={rememberThreadOpener}
			/>
			<a
				className="command-settings icon-button quiet"
				href="#settings"
				aria-label="Settings"
				title="Settings"
				aria-current={settings ? "page" : undefined}
			>
				<WorkspaceIcon name="settings" />
			</a>
		</div>
	);
}

type WorkspaceSubmit = ReturnType<typeof useSubmit>;
function CreateCategoryForm({
	server,
	recordCategory,
	submission,
}: {
	server: WorkspaceClient;
	recordCategory: Directory["recordCategory"];
	submission: WorkspaceSubmit;
}) {
	const { busy, submit } = submission;
	return (
		<details>
			<summary>New category</summary>
			<form
				method="post"
				onSubmit={submit(async (form) => {
					const name = String(new FormData(form).get("name") ?? "").trim();
					const { id } = await server.call("create_category", {
						name,
					});
					if (!form.isConnected) return;
					recordCategory({ id, name });
					form.reset();
					form.closest("details")?.removeAttribute("open");
					location.hash = `channel/${id}`;
				})}
			>
				<label htmlFor="channel-name">Category name</label>
				<input id="channel-name" name="name" maxLength={80} required />
				<button type="submit" disabled={busy}>
					Create category
				</button>
			</form>
		</details>
	);
}

function InboxPane({
	directory,
	events,
	alerts,
}: {
	directory: Directory;
	events: InboxState["events"];
	alerts: ThreadAlerts;
}) {
	const { channels, chats } = directory;
	let alertLabel = alerts.enabled
		? "Turn off browser alerts"
		: "Enable browser alerts";
	if (!alerts.available) alertLabel = "Browser alerts unavailable";
	return (
		<section className="pane inbox-pane">
			<div className="pane-head">
				<p className="eyebrow">Inbox</p>
				<h1>Notifications</h1>
			</div>
			<div className="pane-scroll">
				<p className="hint">Replies and deliveries, newest first.</p>
				<button
					type="button"
					disabled={!alerts.available}
					aria-pressed={alerts.enabled}
					onClick={() => void alerts.toggle()}
				>
					{alertLabel}
				</button>
				{events?.length === 0 && <p className="empty">No replies yet.</p>}
				<ul className="items">
					{events?.map((e) => (
						<li key={e.request}>
							<a href={`#${e.chat}`}>
								<small data-unread={Boolean(e.unread)}>
									{channels.find((c) => c.id === e.channel)?.name} ·{" "}
									{e.unread ? "Unread" : "Read"}
								</small>
								<span className="inbox-thread-title">
									{chats.find((c) => c.id === e.chat)?.title ?? e.title}
								</span>
								{e.preview && (
									<span className="inbox-preview">{e.preview}</span>
								)}
							</a>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}

type CategoryLocation = {
	workspace: WorkspaceRoot;
	navigationRevision: RefObject<number>;
	firstMessage: RefObject<ComposerEditorHandle | null>;
};

type FirstMessageProps = Pick<
	WorkspaceProps,
	"server" | "report" | "drafts" | "attachmentDrafts" | "setAttachmentDrafts"
> & {
	channel: Channel;
	submission: WorkspaceSubmit;
	navigation: CategoryLocation;
	recordThread: Directory["recordThread"];
};

function NewThreadComposer({
	channel,
	server,
	report,
	drafts,
	attachmentDrafts,
	setAttachmentDrafts,
	submission,
	navigation,
	recordThread,
}: FirstMessageProps) {
	const { busy, submit } = submission;
	const { workspace, navigationRevision, firstMessage } = navigation;
	const key = `start/${channel.id}`;
	const firstFiles = attachmentDraft(
		attachmentDrafts,
		setAttachmentDrafts,
		key,
		server,
		report,
	);
	return (
		<form
			data-category={channel.id}
			id="create"
			method="post"
			onSubmit={submit(async () => {
				const text = drafts.get(key)?.text ?? "";
				if (!sendableDraft(text, firstFiles)) return;
				const route = location.hash;
				const submittedAt = navigationRevision.current;
				const draft = requestFor(text, drafts.get(key) ?? null, firstFiles.ids);
				saveComposerDraft(drafts, key, draft, literalDraft(drafts.get(key)));
				const thread = await server.call("start_thread", {
					message: message(draft),
					channel: channel.id,
				});
				if (!workspace.current?.isConnected) return;
				recordThread(thread);
				if (drafts.get(key) !== draft) return;
				drafts.delete(key);
				firstFiles.clear();
				if (
					workspace.current.querySelector<HTMLElement>("#create")?.dataset
						.category === channel.id
				)
					firstMessage.current?.clear();
				// A round trip through another thread can return to the submitted hash.
				if (
					navigationRevision.current === submittedAt &&
					location.hash === route
				)
					location.hash = thread.id;
			})}
		>
			<ComposerEditor
				id="first-message"
				ref={firstMessage}
				server={server}
				label={`New thread in ${channel.name}`}
				placeholder="Write the first message for a new thread…"
				initialMarkdown={drafts.get(key)?.text ?? ""}
				initialLiteralContent={literalDraft(drafts.get(key))}
				onMarkdownChange={(value, literalContent) => {
					if (value)
						saveComposerDraft(
							drafts,
							key,
							requestFor(value, drafts.get(key) ?? null),
							literalContent,
						);
					else drafts.delete(key);
				}}
				blocked={busy}
				hasAttachments={firstFiles.ids.length > 0}
				actions={(limit, formatToggle) => (
					<ComposerActions
						files={firstFiles}
						busy={busy}
						blocked={busy}
						limit={limit}
						formatToggle={formatToggle}
						mode="start"
					/>
				)}
			/>
		</form>
	);
}

function CategoryMenu({
	channel,
	directory,
	server,
	report,
}: {
	channel: Channel;
	directory: Directory;
	server: WorkspaceClient;
	report: Report;
}) {
	const { busy, submit } = useSubmit(report);
	return (
		<details className="category-menu">
			<summary>Category actions</summary>
			<form
				method="post"
				onSubmit={submit(async (form) => {
					const name = String(new FormData(form).get("name") ?? "").trim();
					const saved = await server.call("rename_category", {
						id: channel.id,
						name,
					});
					directory.updateCategory(channel.id, saved);
					form.closest("details")?.removeAttribute("open");
				})}
			>
				<label htmlFor="rename-category">Rename category to</label>
				<input
					key={channel.name}
					id="rename-category"
					name="name"
					defaultValue={channel.name}
					maxLength={80}
					required
				/>
				<button type="submit" disabled={busy}>
					Rename category
				</button>
			</form>
			{channel.id !== "general" && (
				<form
					method="post"
					onSubmit={submit(async (form) => {
						const saved = await server.call("archive_category", {
							id: channel.id,
							archived: !channel.archived,
						});
						directory.updateCategory(channel.id, {
							archived: saved.archived ? 1 : 0,
						});
						const menu = form.closest("details");
						menu?.removeAttribute("open");
						menu?.querySelector("summary")?.focus();
					})}
				>
					<button className="quiet" type="submit" disabled={busy}>
						{channel.archived ? "Restore category" : "Archive category"}
					</button>
				</form>
			)}
		</details>
	);
}

function CategoryPane({
	channel,
	directory,
	unread,
	history,
	focus,
	menu,
	compose,
}: {
	channel: Channel;
	directory: Directory;
	unread: Map<string, number>;
	history: CategoryHistory;
	focus: ReturnType<typeof useThreadFocus>;
	menu: ReactNode;
	compose: ReactNode;
}) {
	const threads = directory.chats.filter(
		(chat) =>
			chat.channel === channel.id && (channel.archived || !chat.archived),
	);
	const { categoryFeed } = history;
	const { categoryHeading, rememberThreadOpener } = focus;
	return (
		<section className="pane category-pane" key={channel.id}>
			<div className="pane-head">
				<div className="category-identity">
					<span className="category-mark" aria-hidden="true">
						#
					</span>
					<div>
						<p className="eyebrow">
							{channel.archived ? "Archived category" : "Category"}
						</p>
						<h1 ref={categoryHeading} tabIndex={-1}>
							{channel.name}
						</h1>
					</div>
				</div>
				{menu}
			</div>
			<div
				className="pane-scroll"
				ref={categoryFeed}
				data-category={channel.id}
			>
				<h2 className="section-title">
					Threads <span>{threads.length}</span>
				</h2>
				{threads.length === 0 && (
					<p className="empty">
						{channel.archived
							? "No threads in this category."
							: "No threads yet. Start one below."}
					</p>
				)}
				<ul className="category-threads">
					{threads.map((c) => {
						const count = unread.get(c.id) ?? 0;
						return (
							<li key={c.id}>
								<a
									href={`#${c.id}`}
									onClick={(e) => {
										if (isPlainLinkClick(e)) rememberThreadOpener(c);
									}}
								>
									<span className="thread-row-icon">
										<WorkspaceIcon name="thread" />
									</span>
									<span className="thread-row-title">{c.title}</span>
									{(c.archived === 1 || count > 0) && (
										<span className="thread-row-meta">
											{c.archived === 1 && (
												<small className="badge">Archived</small>
											)}
											{count > 0 && (
												<small className="badge">{count} unread</small>
											)}
										</span>
									)}
									<WorkspaceIcon name="forward" />
								</a>
							</li>
						);
					})}
				</ul>
			</div>
			{channel.archived ? (
				<p className="archive-notice" role="status">
					Restore this category to start a thread.
				</p>
			) : (
				compose
			)}
		</section>
	);
}

function ThreadPane({
	chat,
	channel,
	directory,
	inbox,
	alerts,
	obscured,
	profile,
	config,
}: {
	chat: Chat;
	channel: Channel;
	directory: Directory;
	inbox: InboxState;
	alerts: ThreadAlerts;
	obscured: boolean;
	profile: Profile | undefined;
	config: WorkspaceProps;
}) {
	const {
		server,
		drafts,
		report,
		mediaClient,
		attachmentDrafts,
		setAttachmentDrafts,
	} = config;
	const events = inbox.events?.filter((event) => event.chat === chat.id) ?? [];
	async function move(destination: string) {
		const moved = await server.call("move_thread", {
			id: chat.id,
			channel: destination,
		});
		directory.updateThread(moved.id, { channel: moved.channel });
		inbox.moveEvents(moved.id, moved.channel);
	}
	async function archive(archived: boolean) {
		const saved = await server.call("archive_thread", {
			id: chat.id,
			archived,
		});
		directory.updateThread(chat.id, { archived: saved.archived ? 1 : 0 });
	}
	async function rename(title: string) {
		const saved = await server.call("rename_thread", { id: chat.id, title });
		directory.updateThread(chat.id, { title: saved.title });
	}
	return (
		<Conversation
			events={events}
			alerts={alerts}
			drawerOpen={obscured}
			onRead={inbox.onRead}
			chat={chat}
			channel={channel}
			channels={directory.channels.filter((item) => !item.archived)}
			profile={profile}
			mediaClient={mediaClient}
			attachmentDrafts={attachmentDrafts}
			setAttachmentDrafts={setAttachmentDrafts}
			move={move}
			archive={archive}
			markRead={
				events.some((event) => event.unread)
					? () => void inbox.markRead(chat.id)
					: undefined
			}
			server={server}
			drafts={drafts}
			rename={rename}
			report={report}
		/>
	);
}

function WorkspacePane({
	config,
	route,
	directory,
	inbox,
	alerts,
	obscured,
	profile,
	expireWorkspace,
	category,
}: {
	config: WorkspaceProps;
	route: WorkspaceRoute;
	directory: Directory;
	inbox: InboxState;
	alerts: ThreadAlerts;
	obscured: boolean;
	profile: ReturnType<typeof useWorkspaceProfile>;
	expireWorkspace: Report;
	category: ReactNode;
}) {
	const { server, report, mediaClient, changeServer } = config;
	if (route.settings)
		return (
			<DeviceSettings
				server={server}
				report={report}
				logout={() => expireWorkspace("")}
				changeServer={changeServer}
			>
				<ProfileSettings
					profile={profile.profile}
					server={server}
					base={mediaClient}
					onProfile={profile.setProfile}
					report={report}
				/>
			</DeviceSettings>
		);
	if (route.inbox)
		return (
			<InboxPane directory={directory} events={inbox.events} alerts={alerts} />
		);
	if (route.archive) return <ArchivePane {...directory} />;
	if (route.chat && route.channel)
		return (
			<ThreadPane
				key={route.chat.id}
				chat={route.chat}
				channel={route.channel}
				directory={directory}
				inbox={inbox}
				alerts={alerts}
				obscured={obscured}
				profile={profile.profile}
				config={config}
			/>
		);
	if (route.channel) return category;
	return (
		<section className="pane">
			<div className="pane-head">
				<h1>
					{directory.channels.length ? "Not found" : "Opening workspace…"}
				</h1>
			</div>
		</section>
	);
}

function Workspace(config: WorkspaceProps) {
	const { server, report, expire } = config;
	const workspace = useRef<HTMLDivElement>(null);
	const expireWorkspace = useCallback(
		(message: string) => {
			if (workspace.current?.isConnected) expire(message);
		},
		[expire],
	);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const obscured = drawerOpen || searchOpen;
	const firstMessage = useRef<ComposerEditorHandle>(null);
	const alerts = useBrowserAlerts(report);
	const directory = useWorkspaceDirectory(server, report);
	const active = activeDirectory(directory);
	const history = useCategoryHistory(workspace, report);
	const route = workspaceRoute(directory, history.selected);
	const focus = useThreadFocus(
		workspace,
		history,
		route.threadId,
		route.channel?.id,
	);
	useFirstMessageFocus(workspace, history);
	const inbox = useWorkspaceInbox(server, report, alerts);
	const profile = useWorkspaceProfile(server, report, route.settings);
	useBackgroundAlerts(inbox.events, history.selected, obscured, alerts.notify);
	const { unread, total } = unreadCounts(inbox.events);
	const submission = useSubmit(report);
	const category = route.channel && (
		<CategoryPane
			key={route.channel.id}
			channel={route.channel}
			directory={directory}
			unread={unread}
			history={history}
			focus={focus}
			menu={
				<CategoryMenu
					channel={route.channel}
					directory={directory}
					server={server}
					report={report}
				/>
			}
			compose={
				<NewThreadComposer
					{...config}
					channel={route.channel}
					submission={submission}
					navigation={{
						workspace,
						navigationRevision: history.navigationRevision,
						firstMessage,
					}}
					recordThread={directory.recordThread}
				/>
			}
		/>
	);
	return (
		<div
			id="workspace"
			ref={workspace}
			data-global-view={route.settings || route.inbox}
		>
			<WorkspaceCommandBar
				route={route}
				directory={directory}
				setSearchOpen={setSearchOpen}
				rememberThreadOpener={focus.rememberThreadOpener}
			/>
			<WorkspaceRail
				selected={history.selected}
				category={route.channel?.archived ? undefined : route.channel?.id}
				total={total}
			/>
			<WorkspaceNav
				channels={active.channels}
				chats={active.chats}
				unread={unread}
				total={total}
				selected={history.selected}
				category={route.channel?.id}
				setDrawerOpen={setDrawerOpen}
				onDesktopCategoryOpen={focus.onDesktopCategoryOpen}
				onThreadOpen={focus.rememberThreadOpener}
				startThread={history.startThread}
			>
				<CreateCategoryForm
					server={server}
					recordCategory={directory.recordCategory}
					submission={submission}
				/>
			</WorkspaceNav>
			<WorkspacePane
				config={config}
				route={route}
				directory={directory}
				inbox={inbox}
				alerts={alerts}
				obscured={obscured}
				profile={profile}
				expireWorkspace={expireWorkspace}
				category={category}
			/>
		</div>
	);
}

type Device = {
	id: string;
	name: string;
	created_at: number;
	expires_at: number;
};
type Devices = { current: string; devices: Device[] };
function AppearanceSettings() {
	const [theme, setTheme] = useState(
		() => document.documentElement.dataset.theme ?? "system",
	);
	return (
		<section className="settings-appearance" aria-labelledby="appearance">
			<h2 id="appearance">Appearance</h2>
			<label htmlFor="theme">Theme</label>
			<select
				id="theme"
				value={theme}
				onChange={(event) => {
					const choice = event.currentTarget.value;
					const { dataset } = document.documentElement;
					if (choice === "system") delete dataset.theme;
					else dataset.theme = choice;
					setTheme(choice);
					try {
						localStorage.setItem("rothcold-theme", choice);
					} catch {
						// The choice still applies to this page when storage is unavailable.
					}
				}}
			>
				<option value="system">Follow system</option>
				<option value="light">Light</option>
				<option value="dark">Dark</option>
			</select>
		</section>
	);
}

function DeviceSettings({
	server,
	report,
	logout,
	changeServer,
	children,
}: {
	server: WorkspaceClient;
	report: Report;
	logout: () => void;
	changeServer: () => void;
	children: ReactNode;
}) {
	const [devices, setDevices] = useState<Devices>();
	const { busy, submit } = useSubmit(report);
	useEffect(() => {
		let active = true;
		void server.devices().then(
			(list) => {
				if (active) setDevices(list);
			},
			(e) => {
				if (active) report(failure(e));
			},
		);
		return () => {
			active = false;
		};
	}, [server, report]);
	return (
		<section className="pane">
			<div className="pane-head">
				<h1>Settings</h1>
			</div>
			<div className="pane-scroll">
				<div className="settings-connection">
					<p>
						Connected to <strong>{server.selection.backend.label}</strong>
					</p>
					<div className="settings-actions">
						<button
							type="button"
							className="quiet"
							onClick={changeServer}
							disabled={busy}
						>
							Change server
						</button>
						<form
							method="post"
							onSubmit={submit(async () => {
								await server.call("logout", {});
								await server.forget().catch(() => {});
								logout();
							})}
						>
							<button type="submit" disabled={busy}>
								Sign out this device
							</button>
						</form>
					</div>
				</div>
				<AppearanceSettings />
				{children}
				<h2>Signed-in devices</h2>
				{devices && (
					<ul className="items">
						{devices.devices.map(({ id, name, created_at, expires_at }) => (
							<li key={id} className="device-row">
								<div>
									<p>
										{name}
										{id === devices.current ? " (this device)" : ""}
									</p>
									<small>
										Signed in {new Date(created_at * 1000).toLocaleString()} ·
										Expires {new Date(expires_at * 1000).toLocaleString()}
									</small>
								</div>
								{id !== devices.current && (
									<form
										method="post"
										onSubmit={submit(async () => {
											await server.call("revoke_device", { id });
											setDevices(
												(list) =>
													list && {
														...list,
														devices: list.devices.filter(
															(device) => device.id !== id,
														),
													},
											);
										})}
									>
										<button
											type="submit"
											disabled={busy}
											className="danger-action"
											aria-label={`Revoke ${name}`}
										>
											Revoke
										</button>
									</form>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</section>
	);
}

const connectionPreference = "rothcold.noise-selection";
function rememberedSelection():
	| { id: string; scope: string; pin: string }
	| undefined {
	try {
		const data = JSON.parse(
			localStorage.getItem(connectionPreference) ?? "null",
		);
		if (
			data &&
			typeof data.id === "string" &&
			/^[0-9a-f]{64}$/.test(data.scope) &&
			/^[0-9a-f]{64}$/.test(data.pin)
		)
			return data;
	} catch {
		/* Public preferences may be unavailable. */
	}
}
function rememberSelection({ backend, pin }: Selection) {
	try {
		localStorage.setItem(
			connectionPreference,
			JSON.stringify({ id: backend.id, scope: backend.scope, pin }),
		);
	} catch {
		/* The current connection still works. */
	}
}

type Gate =
	| { page: "loading" | "connect" }
	| { page: "login" | "workspace" | "reconnect"; client: WorkspaceClient };
function ConnectScreen({
	backends,
	selected,
	pin,
	choose,
	updatePin,
	busy,
	submit,
	cancel,
}: {
	backends: Backend[];
	selected: string;
	pin: string;
	choose: (id: string) => void;
	updatePin: (pin: string) => void;
	busy: boolean;
	submit: FormEventHandler<HTMLFormElement>;
	cancel?: () => void;
}) {
	return (
		<section id="gate">
			<p className="eyebrow">Private workspace</p>
			<h1>Connect to a server</h1>
			<p>
				Choose a trusted backend and enter the Noise pin verified independently
				with its operator.
			</p>
			<form method="post" onSubmit={submit}>
				<label htmlFor="server-address">Trusted backend</label>
				<select
					id="server-address"
					value={selected}
					required
					disabled={busy || !backends.length}
					onChange={(event) => choose(event.target.value)}
				>
					{backends.map(({ id, label }) => (
						<option key={id} value={id}>
							{label}
						</option>
					))}
				</select>
				<label htmlFor="responder-pin">Trusted Noise pin</label>
				<input
					id="responder-pin"
					value={pin}
					required
					maxLength={64}
					disabled={busy}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => updatePin(event.target.value)}
				/>
				<div className="rename-actions">
					<button
						className="primary-action"
						type="submit"
						disabled={busy || !backends.length}
					>
						Connect
					</button>
					{cancel && (
						<button
							type="button"
							className="quiet"
							disabled={busy}
							onClick={cancel}
						>
							Cancel
						</button>
					)}
				</div>
			</form>
		</section>
	);
}

function LoginScreen({
	backend,
	busy,
	submit,
	changeServer,
}: {
	backend: Backend;
	busy: boolean;
	submit: FormEventHandler<HTMLFormElement>;
	changeServer: () => void;
}) {
	return (
		<section id="gate">
			<p className="eyebrow">Private workspace</p>
			<h1>Sign in</h1>
			<p>
				Connected to <strong>{backend.label}</strong> with a verified Noise pin.
			</p>
			<form method="post" onSubmit={submit}>
				<label htmlFor="token">Owner token</label>
				<input
					id="token"
					name="token"
					type="password"
					required
					maxLength={512}
					autoComplete="off"
				/>
				<label htmlFor="device-name">Device name (optional)</label>
				<input
					id="device-name"
					name="name"
					maxLength={80}
					placeholder="Web browser"
				/>
				<div className="rename-actions">
					<button className="primary-action" type="submit" disabled={busy}>
						Open workspace
					</button>
					<button
						type="button"
						className="quiet"
						disabled={busy}
						onClick={changeServer}
					>
						Change server
					</button>
				</div>
			</form>
		</section>
	);
}

function ReconnectScreen({
	backend,
	busy,
	submit,
	changeServer,
}: {
	backend: Backend;
	busy: boolean;
	submit: FormEventHandler<HTMLFormElement>;
	changeServer: () => void;
}) {
	return (
		<section id="gate">
			<p className="eyebrow">Private workspace</p>
			<h1>Connection lost</h1>
			<p>
				Reconnect to {backend.label} to refresh the workspace. Drafts are not
				sent again automatically.
			</p>
			<form method="post" onSubmit={submit}>
				<div className="rename-actions">
					<button type="submit" className="primary-action" disabled={busy}>
						Reconnect
					</button>
					<button
						type="button"
						className="quiet"
						disabled={busy}
						onClick={changeServer}
					>
						Change server
					</button>
				</div>
			</form>
		</section>
	);
}

function App() {
	const [gate, setGate] = useState<Gate>({ page: "loading" });
	const [backends, setBackends] = useState<Backend[]>([]);
	const [serverId, setServerId] = useState("");
	const [pin, setPin] = useState("");
	const [previous, setPrevious] = useState<{
		selection: Selection;
		wasDisconnected: boolean;
	}>();
	const [restoringPrevious, setRestoringPrevious] = useState(false);
	const clientRef = useRef<WorkspaceClient>(undefined);
	const drafts = useRef(new Map<string, Draft>());
	const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDrafts>(
		{},
	);
	const [notice, report] = useState("");
	const { busy, submit } = useSubmit(report);
	const clearDrafts = useCallback(() => {
		drafts.current = new Map();
		setAttachmentDrafts({});
	}, []);
	const expire = useCallback(
		(detail: string) => {
			const client = clientRef.current;
			if (!client) return;
			client.close();
			clearDrafts();
			report(detail);
			const next = new WorkspaceClient(client.selection);
			clientRef.current = next;
			setGate({ page: "login", client: next });
		},
		[clearDrafts],
	);
	const clearIncompleteUploads = useCallback(() => {
		setAttachmentDrafts((all) =>
			Object.fromEntries(
				Object.entries(all).map(([key, entries]) => [
					key,
					entries.filter((entry) => entry.item),
				]),
			),
		);
	}, []);
	const watchConnection = useCallback(
		(client: WorkspaceClient) => {
			client.onExpired((error) => {
				if (clientRef.current === client) expire(error.message);
			});
			client.onLost(({ uncertain }) => {
				if (clientRef.current !== client) return;
				for (const [key, draft] of drafts.current) {
					if (isApprovalDraft(draft.text)) drafts.current.delete(key);
					else if (draft.approval)
						drafts.current.set(key, { ...draft, approval: undefined });
				}
				clearIncompleteUploads();
				report(
					uncertain
						? "A submitted change may have committed without a receipt. Check the workspace after reconnecting; nothing was retried."
						: "",
				);
				setGate({ page: "reconnect", client });
			});
		},
		[clearIncompleteUploads, expire],
	);
	const openSelection = useCallback(
		async (selection: Selection, beforeDisplay?: () => void) => {
			clientRef.current?.close();
			const client = new WorkspaceClient(selection);
			clientRef.current = client;
			watchConnection(client);
			const warning = await client.check();
			if (clientRef.current !== client || client.signal.aborted) return;
			if (warning) report(warning.message);
			beforeDisplay?.();
			setGate({ page: client.authorized ? "workspace" : "login", client });
		},
		[watchConnection],
	);
	useEffect(() => {
		let active = true;
		void (async () => {
			try {
				const config = await configuredBackends();
				if (!active) return;
				setBackends(config.backends);
				const remembered = rememberedSelection();
				const backend = config.backends.find(
					(item) =>
						item.id === remembered?.id && item.scope === remembered.scope,
				);
				setServerId(backend?.id ?? config.defaultBackend);
				if (backend && remembered) {
					setPin(remembered.pin);
					await openSelection({ backend, pin: remembered.pin });
				} else setGate({ page: "connect" });
			} catch (error) {
				if (active) {
					report(failure(error));
					setGate({ page: "connect" });
				}
			}
		})();
		return () => {
			active = false;
			clientRef.current?.close();
			clientRef.current = undefined;
		};
	}, [openSelection]);
	function changeServer() {
		const client = clientRef.current;
		if (!client) return;
		setPrevious({
			selection: client.selection,
			wasDisconnected: gate.page === "reconnect",
		});
		setServerId(client.selection.backend.id);
		setPin(client.selection.pin);
		client.close();
		clearIncompleteUploads();
		clientRef.current = undefined;
		report("");
		setGate({ page: "connect" });
	}
	async function connect() {
		const backend = backends.find(({ id }) => id === serverId);
		if (!backend) throw new Error("Choose a configured trusted backend.");
		const next = { backend, pin: pin.trim().toLowerCase() };
		await openSelection(next, () => {
			if (previous && selectionKey(previous.selection) !== selectionKey(next)) {
				// Never apply a different responder's route or draft to the verified workspace.
				history.replaceState(null, "", location.pathname);
				clearDrafts();
			}
		});
		rememberSelection(next);
		setPrevious(undefined);
	}
	async function cancelServerChange() {
		if (!previous || restoringPrevious) return;
		report("");
		if (previous.wasDisconnected) {
			clientRef.current?.close();
			const client = new WorkspaceClient(previous.selection);
			clientRef.current = client;
			setGate({ page: "reconnect", client });
			setPrevious(undefined);
			return;
		}
		setRestoringPrevious(true);
		try {
			await openSelection(previous.selection);
			setPrevious(undefined);
		} catch (error) {
			report(failure(error));
		} finally {
			setRestoringPrevious(false);
		}
	}
	async function signIn(form: HTMLFormElement) {
		if (gate.page !== "login") return;
		const { client } = gate;
		const token = form.elements.namedItem("token");
		const name = form.elements.namedItem("name");
		if (
			!(token instanceof HTMLInputElement) ||
			!(name instanceof HTMLInputElement)
		)
			return;
		watchConnection(client);
		const enrollment = client.enroll(
			token.value,
			name.value.trim() || "Web browser",
		);
		form.reset();
		await enrollment;
		if (clientRef.current !== client || client.signal.aborted) return;
		setGate({ page: "workspace", client });
	}
	const currentServer = gate.page === "workspace" ? gate.client : undefined;
	const reportWorkspace = useCallback(
		(detail: string) => {
			if (clientRef.current === currentServer && !currentServer?.signal.aborted)
				report(detail);
		},
		[currentServer],
	);
	return (
		<>
			{gate.page !== "workspace" && (
				<header>
					<img className="mark" src="/brand/icon-dark.svg" alt="" />
					rothcold-agent <span className="sub">Hermes</span>
				</header>
			)}
			<main
				className={gate.page === "workspace" ? "workspace-main" : "gate-main"}
			>
				{gate.page === "workspace" && (
					<Workspace
						key={gate.client.key}
						server={gate.client}
						mediaClient={gate.client}
						attachmentDrafts={attachmentDrafts}
						setAttachmentDrafts={setAttachmentDrafts}
						report={reportWorkspace}
						expire={expire}
						drafts={drafts.current}
						changeServer={changeServer}
					/>
				)}
				{gate.page === "loading" && (
					<section id="gate">
						<h1>Opening workspace…</h1>
					</section>
				)}
				{gate.page === "connect" && (
					<ConnectScreen
						backends={backends}
						selected={serverId}
						pin={pin}
						choose={(id) => {
							setServerId(id);
							setPin(
								id === previous?.selection.backend.id
									? previous.selection.pin
									: "",
							);
						}}
						updatePin={setPin}
						busy={busy || restoringPrevious}
						submit={submit(connect)}
						cancel={previous ? () => void cancelServerChange() : undefined}
					/>
				)}
				{gate.page === "reconnect" && (
					<ReconnectScreen
						backend={gate.client.selection.backend}
						busy={busy}
						changeServer={changeServer}
						submit={submit(async () => {
							await openSelection(gate.client.selection);
						})}
					/>
				)}
				{gate.page === "login" && (
					<LoginScreen
						backend={gate.client.selection.backend}
						busy={busy}
						submit={submit(signIn)}
						changeServer={changeServer}
					/>
				)}
				<p id="notice" role="status">
					{notice}
				</p>
			</main>
		</>
	);
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
