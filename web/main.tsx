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
	api,
	connection,
	SessionExpired,
	pending,
	replyDraft,
	requestFor,
	type Chat,
	type Channel,
	type InboxEvent,
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
			try {
				await action(e.currentTarget);
			} catch (e) {
				report(failure(e));
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
	mediaBase,
	decide,
}: {
	updates: TurnUpdate[];
	agentName: string;
	agentAvatar?: string | null;
	mediaBase: string;
	decide?: (id: string, text: string) => void;
}) {
	return (
		<div className="activity-list">
			{updates.map((u) => {
				if (u.kind === "progress")
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
											onClick={() =>
												decide(u.id, c === "deny" ? "/deny" : `/approve ${c}`)
											}
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
								base={mediaBase}
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
	report,
}: {
	title: string;
	channel: Channel;
	channels: Channel[];
	move: (channel: string) => Promise<void>;
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
			{destination !== null && (
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
	mediaBase: string;
	attachmentDrafts: AttachmentDrafts;
	setAttachmentDrafts: SetAttachmentDrafts;
	move: (channel: string) => Promise<void>;
	markRead?: () => void;
	events: InboxEvent[];
	alerts: ReturnType<typeof useBrowserAlerts>;
	onRead: (id: string, chat: string) => Promise<boolean>;
	drawerOpen: boolean;
	server: string;
	report: Report;
	drafts: Map<string, Draft>;
	rename: (title: string) => Promise<void>;
};
type ThreadAlerts = ReturnType<typeof useBrowserAlerts>;

function useConversationHistory(
	path: string,
	server: string,
	report: Report,
	newest?: string,
) {
	const [turns, setTurns] = useState<Turn[] | null>(null);
	const [revision, reload] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: each successful POST invalidates the current history revision
	useEffect(() => {
		let active = true;
		let timer: number;
		async function read() {
			try {
				const rows = await api<Turn[]>(path, server);
				if (!active) return;
				setTurns(rows);
				if (pending(rows)) timer = window.setTimeout(read, 1500);
			} catch (e) {
				if (active) report(failure(e));
			}
		}
		void read();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [path, server, report, revision, newest]);
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
	path,
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
	path: string;
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
				await api(path, server, draft);
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
	decide: (id: string, choice: string) => Promise<void>;
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
	mediaBase,
	decide,
}: {
	turn: Turn;
	profile: Profile | undefined;
	mediaBase: string;
	decide: TurnActions["decide"];
}) {
	if (!turn.updates.length) return null;
	const agentName = profile?.agent.name || fallbackName.agent;
	const activity = (
		<ActivityList
			updates={turn.updates}
			agentName={agentName}
			agentAvatar={profile?.agent.avatar}
			mediaBase={mediaBase}
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
	mediaBase,
}: {
	turn: Turn;
	profile?: Profile;
	mediaBase: string;
}) {
	if (!turn.text && !turn.attachments?.length) return null;
	return (
		<div className="user-turn">
			<IdentityAvatar
				identity="owner"
				id={profile?.owner.avatar}
				base={mediaBase}
			/>
			<p className="speaker">{profile?.owner.name || fallbackName.owner}</p>
			{turn.text && <p className="message">{turn.text}</p>}
			{turn.attachments && (
				<SentAttachments items={turn.attachments} base={mediaBase} />
			)}
		</div>
	);
}

type TurnTimelineProps = Pick<
	ConversationProps,
	| "chat"
	| "profile"
	| "mediaBase"
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
		mediaBase,
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
			<OwnerTurn turn={turn} profile={profile} mediaBase={mediaBase} />
			<div className="assistant-turn">
				<IdentityAvatar
					identity="agent"
					id={profile?.agent.avatar}
					base={mediaBase}
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
					mediaBase={mediaBase}
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
	path: string,
	server: string,
	report: Report,
	invalidate: () => void,
): TurnActions {
	return {
		async decide(approval, text) {
			try {
				await api(path, server, { id: crypto.randomUUID(), text, approval });
				invalidate();
			} catch (error) {
				report(failure(error));
			}
		},
		async stopWaiting(id) {
			try {
				await api(`${path}/${encodeURIComponent(id)}/stop-waiting`, server, {});
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
		markRead,
		rename,
		report,
		server,
		events,
	} = props;
	const path = `chats/${chat.id}/turns`;
	const { turns, invalidate } = useConversationHistory(
		path,
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
					markRead={markRead}
					rename={rename}
					report={report}
				/>
			</div>
			<TurnTimeline
				turns={turns}
				follow={follow}
				workspace={props}
				actions={threadActions(path, server, report, invalidate)}
			/>
			<ReplyComposer
				{...props}
				path={path}
				turns={turns}
				sent={() => {
					follow.current = true;
					invalidate();
				}}
			/>
		</section>
	);
}
type ThreadOpener = { id: string; trigger?: HTMLElement };
type WorkspaceRoot = RefObject<HTMLDivElement | null>;
type WorkspaceProps = {
	server: string;
	mediaBase: string;
	attachmentDrafts: AttachmentDrafts;
	setAttachmentDrafts: SetAttachmentDrafts;
	report: Report;
	expire: Report;
	changeServer: () => void;
	drafts: Map<string, Draft>;
};

function useWorkspaceDirectory(server: string, report: Report) {
	const [channels, setChannels] = useState<Channel[]>([]);
	const [chats, setChats] = useState<Chat[]>([]);
	const threadRevision = useRef(0);
	useEffect(() => {
		let active = true;
		let timer: number;
		async function refreshTitles() {
			const revision = threadRevision.current;
			try {
				const threads = await api<Chat[]>("chats", server);
				if (active && revision === threadRevision.current) {
					const titles = new Map(threads.map(({ id, title }) => [id, title]));
					setChats((list) => {
						let changed = false;
						const next = list.map((chat) => {
							const title = titles.get(chat.id);
							if (title === undefined || title === chat.title) return chat;
							changed = true;
							return { ...chat, title };
						});
						return changed ? next : list;
					});
				}
			} catch {
				// A background title refresh cannot block workspace use.
			} finally {
				if (active) timer = window.setTimeout(refreshTitles, 4000);
			}
		}
		async function load() {
			try {
				const [groups, threads] = await Promise.all([
					api<Channel[]>("channels", server),
					api<Chat[]>("chats", server),
				]);
				if (active) {
					setChannels(groups);
					setChats(threads);
					timer = window.setTimeout(refreshTitles, 4000);
				}
			} catch (e) {
				if (active) report(failure(e));
			}
		}
		void load();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [server, report]);
	function recordThread(thread: Chat) {
		threadRevision.current += 1;
		setChats((list) => [
			thread,
			...list.filter((chat) => chat.id !== thread.id),
		]);
	}
	function recordCategory(channel: Channel) {
		setChannels((list) => [...list, channel]);
	}
	function updateThread(id: string, patch: Partial<Chat>) {
		threadRevision.current += 1;
		setChats((list) =>
			list.map((chat) => (chat.id === id ? { ...chat, ...patch } : chat)),
		);
	}
	return { channels, chats, recordThread, recordCategory, updateThread };
}
type Directory = ReturnType<typeof useWorkspaceDirectory>;

function useWorkspaceProfile(
	server: string,
	report: Report,
	settings: boolean,
) {
	const [profile, setProfile] = useState<Profile>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: opening Settings also refreshes discoverable backends
	useEffect(() => {
		let active = true;
		void api<Profile>("profile", server).then(
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
	server: string,
	report: Report,
	expireWorkspace: Report,
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
				const rows = await api<InboxEvent[]>("notifications", server);
				if (active) {
					capture(rows);
					setEvents(rows);
				}
			} catch (e) {
				if (active) {
					if (e instanceof SessionExpired) expireWorkspace(e.message);
					else report(failure(e));
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
	}, [server, report, revision, capture, expireWorkspace]);
	const onRead = useCallback(
		async (id: string, chat: string) => {
			try {
				await api(`chats/${chat}/read/${encodeURIComponent(id)}`, server, {});
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
			await api(`chats/${id}/read`, server, {});
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
	const threadId = !inbox && !settings ? chat?.id : undefined;
	return { chat, channel, inbox, settings, threadId };
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
	const { inbox, settings, channel, chat } = route;
	const { channels, chats } = directory;
	return (
		<div className="command-bar">
			<nav className="workspace-path" aria-label="Breadcrumb">
				{settings && <span aria-current="page">Settings</span>}
				{inbox && <span aria-current="page">Inbox</span>}
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
	server: string;
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
					const { id } = await api<{ id: string }>("channels", server, {
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
								<span>{chats.find((c) => c.id === e.chat)?.title}</span>
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
				const thread = await api<Chat>("chats", server, {
					...draft,
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

function CategoryPane({
	channel,
	directory,
	unread,
	history,
	focus,
	compose,
}: {
	channel: Channel;
	directory: Directory;
	unread: Map<string, number>;
	history: CategoryHistory;
	focus: ReturnType<typeof useThreadFocus>;
	compose: ReactNode;
}) {
	const threads = directory.chats.filter((chat) => chat.channel === channel.id);
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
						<p className="eyebrow">Category</p>
						<h1 ref={categoryHeading} tabIndex={-1}>
							{channel.name}
						</h1>
					</div>
				</div>
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
					<p className="empty">No threads yet. Start one below.</p>
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
									{count > 0 && <small className="badge">{count} unread</small>}
									<WorkspaceIcon name="forward" />
								</a>
							</li>
						);
					})}
				</ul>
			</div>
			{compose}
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
		mediaBase,
		attachmentDrafts,
		setAttachmentDrafts,
	} = config;
	const events = inbox.events?.filter((event) => event.chat === chat.id) ?? [];
	async function move(destination: string) {
		const moved = await api<Pick<Chat, "id" | "channel">>(
			`chats/${chat.id}/move`,
			server,
			{ channel: destination },
		);
		directory.updateThread(moved.id, { channel: moved.channel });
		inbox.moveEvents(moved.id, moved.channel);
	}
	async function rename(title: string) {
		const saved = await api<{ title: string }>(
			`chats/${chat.id}/rename`,
			server,
			{ title },
		);
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
			channels={directory.channels}
			profile={profile}
			mediaBase={mediaBase}
			attachmentDrafts={attachmentDrafts}
			setAttachmentDrafts={setAttachmentDrafts}
			move={move}
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
	const { server, report, mediaBase, changeServer } = config;
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
					base={mediaBase}
					onProfile={profile.setProfile}
					report={report}
				/>
			</DeviceSettings>
		);
	if (route.inbox)
		return (
			<InboxPane directory={directory} events={inbox.events} alerts={alerts} />
		);
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
	const history = useCategoryHistory(workspace, report);
	const route = workspaceRoute(directory, history.selected);
	const focus = useThreadFocus(
		workspace,
		history,
		route.threadId,
		route.channel?.id,
	);
	useFirstMessageFocus(workspace, history);
	const inbox = useWorkspaceInbox(server, report, expireWorkspace, alerts);
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
				category={route.channel?.id}
				total={total}
			/>
			<WorkspaceNav
				channels={directory.channels}
				chats={directory.chats}
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
function DeviceSettings({
	server,
	report,
	logout,
	changeServer,
	children,
}: {
	server: string;
	report: Report;
	logout: () => void;
	changeServer: () => void;
	children: ReactNode;
}) {
	const [devices, setDevices] = useState<Devices>();
	const { busy, submit } = useSubmit(report);
	useEffect(() => {
		let active = true;
		void api<Devices>("sessions", server).then(
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
						Connected to <code>{server}</code>
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
								await api("logout", server, {});
								logout();
							})}
						>
							<button type="submit" disabled={busy}>
								Sign out this device
							</button>
						</form>
					</div>
				</div>
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
											await api(`sessions/${id}/revoke`, server, {});
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

const preference = "rothcold.api-server";
function rememberedServer() {
	try {
		return localStorage.getItem(preference);
	} catch {
		return null;
	}
}
function rememberServer(server: string) {
	try {
		localStorage.setItem(preference, server);
	} catch {
		/* storage can be unavailable */
	}
}

type Gate = {
	page: "loading" | "connect" | "login" | "workspace";
	server: string;
	mediaBase: string;
};
async function verifyServer(server: string) {
	const { mediaBase } = await connection<{ mediaBase: string }>(
		"check",
		server,
	);
	let page: Gate["page"] = "workspace";
	try {
		await api("me", server);
	} catch (e) {
		if (!(e instanceof SessionExpired)) throw e;
		page = "login";
	}
	return { page, server, mediaBase };
}
function useRestoreConnection(
	setAddress: (address: string) => void,
	setGate: (next: Gate) => void,
	report: Report,
) {
	useEffect(() => {
		let active = true;
		async function restore() {
			const saved = rememberedServer();
			try {
				const { defaultApi } = await connection<{ defaultApi: string }>(
					"config",
				);
				if (!active) return;
				setAddress(saved ?? defaultApi);
				if (saved) {
					const next = await verifyServer(saved);
					if (active) setGate(next);
				} else setGate({ page: "connect", server: "", mediaBase: "" });
			} catch (e) {
				if (active) {
					if (saved) setAddress(saved);
					report(failure(e));
					setGate({ page: "connect", server: "", mediaBase: "" });
				}
			}
		}
		void restore();
		return () => {
			active = false;
		};
	}, [setAddress, setGate, report]);
}

function ConnectScreen({
	address,
	changeAddress,
	busy,
	submit,
	cancel,
}: {
	address: string;
	changeAddress: (address: string) => void;
	busy: boolean;
	submit: FormEventHandler<HTMLFormElement>;
	cancel?: () => void;
}) {
	return (
		<section id="gate">
			<p className="eyebrow">Private workspace</p>
			<h1>Connect to a server</h1>
			<p>Use an API address configured by your web host administrator.</p>
			<form method="post" onSubmit={submit}>
				<label htmlFor="server-address">Server address</label>
				<input
					id="server-address"
					type="url"
					value={address}
					required
					maxLength={512}
					disabled={busy}
					autoComplete="off"
					onChange={(event) => changeAddress(event.target.value)}
				/>
				<div className="rename-actions">
					<button className="primary-action" type="submit" disabled={busy}>
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
	server,
	busy,
	submit,
	changeServer,
}: {
	server: string;
	busy: boolean;
	submit: FormEventHandler<HTMLFormElement>;
	changeServer: () => void;
}) {
	return (
		<section id="gate">
			<p className="eyebrow">Private workspace</p>
			<h1>Sign in</h1>
			<p>
				Connected to <code>{server}</code>
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

function App() {
	const [gate, setGate] = useState<Gate>({
		page: "loading",
		server: "",
		mediaBase: "",
	});
	const [address, setAddress] = useState("");
	const [previous, setPrevious] = useState<Gate>();
	const drafts = useRef(new Map<string, Draft>());
	const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDrafts>(
		{},
	);
	const [notice, report] = useState("");
	const { busy, submit } = useSubmit(report);
	const expire = useCallback((message: string) => {
		drafts.current = new Map();
		setAttachmentDrafts({});
		report(message);
		setGate((gate) => ({ ...gate, page: "login" }));
	}, []);
	useRestoreConnection(setAddress, setGate, report);
	function changeServer() {
		setPrevious(gate);
		setAddress(gate.server);
		report("");
		setGate({ page: "connect", server: "", mediaBase: "" });
	}
	function cancelServerChange() {
		if (!previous) return;
		report("");
		setGate(previous);
		setPrevious(undefined);
	}
	const connect = async () => {
		const next = await verifyServer(address.trim());
		if (previous?.server !== next.server && (previous || rememberedServer())) {
			drafts.current = new Map();
			setAttachmentDrafts({});
			history.replaceState(null, "", location.pathname);
		}
		rememberServer(next.server);
		setPrevious(undefined);
		setGate(next);
	};
	const signIn = async (form: HTMLFormElement) => {
		const { token, name } = Object.fromEntries(new FormData(form));
		form.reset();
		await api("login", gate.server, {
			token,
			name: String(name).trim() || "Web browser",
		});
		setGate({ ...gate, page: "workspace" });
	};
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
						key={gate.server}
						server={gate.server}
						mediaBase={gate.mediaBase}
						attachmentDrafts={attachmentDrafts}
						setAttachmentDrafts={setAttachmentDrafts}
						report={report}
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
						address={address}
						changeAddress={setAddress}
						busy={busy}
						submit={submit(connect)}
						cancel={previous ? cancelServerChange : undefined}
					/>
				)}
				{gate.page === "login" && (
					<LoginScreen
						server={gate.server}
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
