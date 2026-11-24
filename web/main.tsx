import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type FormEvent,
} from "react";
import { WorkspaceNav } from "./workspace-nav";
import { createRoot } from "react-dom/client";
import {
	api,
	pending,
	requestFor,
	type Chat,
	type Channel,
	type InboxEvent,
	type Draft,
	type Turn,
	type TurnUpdate,
} from "./chat";
import { Markdown } from "./markdown";
import "./app.css";

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
	answered: "",
};
function ActivityList({ updates }: { updates: TurnUpdate[] }) {
	return (
		<div className="activity-list">
			{updates.map((u) =>
				u.kind === "progress" ? (
					<pre key={u.id} className="progress-log">
						{u.text}
					</pre>
				) : (
					<div key={u.id} className="interim-note">
						<p className="interim-label">Hermes · update</p>
						<Markdown text={u.text} />
					</div>
				),
			)}
		</div>
	);
}
function ThreadTitle({
	title,
	channel,
	rename,
	report,
}: {
	title: string;
	channel: Channel;
	rename: (title: string) => Promise<void>;
	report: Report;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const { busy, submit } = useSubmit(report);
	const editing = draft !== null;
	useEffect(() => {
		if (editing) input.current?.select();
	}, [editing]);
	function close() {
		setDraft(null);
		trigger.current?.focus();
	}
	const value = draft?.trim() ?? "";
	return (
		<>
			<div className="thread-tools">
				<a className="breadcrumb" href={`#channel/${channel.id}`}>
					# {channel.name}
				</a>
				<button
					ref={trigger}
					className="quiet"
					type="button"
					aria-expanded={editing}
					aria-disabled={busy}
					onClick={() => {
						if (busy) return;
						if (editing) close();
						else setDraft(title);
					}}
				>
					Rename thread
				</button>
			</div>
			<h1>{title}</h1>
			{draft !== null && (
				<form
					method="post"
					onSubmit={submit(async () => {
						await rename(value);
						close();
					})}
				>
					<label htmlFor="thread-title">Thread title (1–80 characters)</label>
					<input
						ref={input}
						id="thread-title"
						value={draft}
						required
						disabled={busy}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape" && !e.nativeEvent.isComposing) close();
						}}
					/>
					<div className="rename-actions">
						<button
							type="submit"
							disabled={busy || !value || [...value].length > 80}
						>
							Save title
						</button>
						<button
							type="button"
							className="quiet"
							disabled={busy}
							onClick={close}
						>
							Cancel
						</button>
					</div>
				</form>
			)}
		</>
	);
}
function Conversation({
	chat,
	channel,
	markRead,
	session,
	report,
	drafts,
	rename,
}: {
	chat: Chat;
	channel: Channel;
	markRead?: () => void;
	session: string;
	report: Report;
	drafts: Map<string, Draft>;
	rename: (title: string) => Promise<void>;
}) {
	const [turns, setTurns] = useState<Turn[] | null>(null);
	const [revision, reload] = useState(0);
	const [text, setText] = useState(drafts.get(chat.id)?.text ?? "");
	const { busy, submit } = useSubmit(report);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const path = `chats/${chat.id}/turns`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: each successful POST invalidates the current history revision
	useEffect(() => {
		let active = true;
		let timer: number;
		async function read() {
			try {
				const rows = await api<Turn[]>(path, session);
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
	}, [path, session, report, revision]);
	const timeline = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	useLayoutEffect(() => {
		const el = timeline.current;
		if (el && turns && follow.current) el.scrollTop = el.scrollHeight;
	}, [turns]);
	const blocked = !turns || busy;
	return (
		<section className="conversation">
			<div className="pane-head">
				<ThreadTitle
					title={chat.title}
					channel={channel}
					rename={rename}
					report={report}
				/>
				{markRead && (
					<button className="quiet" type="button" onClick={markRead}>
						Mark thread read
					</button>
				)}
			</div>
			<div
				id="turns"
				ref={timeline}
				onScroll={(e) => {
					const el = e.currentTarget;
					follow.current =
						el.scrollHeight - el.scrollTop - el.clientHeight < 48;
				}}
			>
				{turns?.length === 0 && (
					<p className="empty">
						This thread is ready. Send a message when you want Hermes to begin.
					</p>
				)}
				{turns?.map((t) => (
					<article key={t.id} className="turn">
						{t.text && (
							<div className="user-turn">
								<p className="speaker">You</p>
								<p className="message">{t.text}</p>
							</div>
						)}
						{t.answer === null ? (
							<div className="assistant-turn">
								{t.updates.length > 0 && <ActivityList updates={t.updates} />}
								<p className="status-line">
									<small>
										{t.state === "accepted" && t.updates.length > 0
											? "Accepted by Hermes. Working…"
											: statuses[t.state]}
									</small>
								</p>
							</div>
						) : (
							<div className="assistant-turn">
								{t.updates.length > 0 && (
									<details className="activity-details">
										<summary>
											Activity ({t.updates.length}{" "}
											{t.updates.length === 1 ? "update" : "updates"})
										</summary>
										<ActivityList updates={t.updates} />
									</details>
								)}
								<p className="speaker">
									Hermes
									{!t.text && <span className="push-tag">Delivered</span>}
								</p>
								<Markdown text={t.answer} />
							</div>
						)}
					</article>
				))}
			</div>
			<form
				id="compose"
				method="post"
				onSubmit={submit(async () => {
					if (blocked || !text.trim()) return;
					const draft = requestFor(text, drafts.get(chat.id) ?? null);
					drafts.set(chat.id, draft);
					await api(path, session, draft);
					// A reopened composer may still hold this draft. Its explicit retry must reuse the ID.
					if (!mounted.current) return;
					if (drafts.get(chat.id) === draft) drafts.delete(chat.id);
					setText("");
					follow.current = true;
					reload((n) => n + 1);
				})}
			>
				<label htmlFor="text">Your message</label>
				<textarea
					id="text"
					placeholder="Write a reply…"
					value={text}
					onChange={(e) => {
						const value = e.target.value;
						setText(value);
						if (value)
							drafts.set(
								chat.id,
								requestFor(value, drafts.get(chat.id) ?? null),
							);
						else drafts.delete(chat.id);
					}}
					disabled={blocked}
					rows={3}
					maxLength={8000}
					required
				/>
				<button type="submit" disabled={blocked}>
					Send message
				</button>
			</form>
		</section>
	);
}
function Workspace({ session, report }: { session: string; report: Report }) {
	const [channels, setChannels] = useState<Channel[]>([]);
	const [chats, setChats] = useState<Chat[]>([]);
	const [events, setEvents] = useState<InboxEvent[] | null>(null);
	const [revision, refresh] = useState(0);
	const drafts = useRef(new Map<string, Draft>());
	const [selected, select] = useState(location.hash.slice(1));
	const { busy, submit } = useSubmit(report);
	useEffect(() => {
		const navigate = () => {
			report("");
			select(location.hash.slice(1));
		};
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, [report]);
	useEffect(() => {
		async function load() {
			const [groups, threads] = await Promise.all([
				api<Channel[]>("channels", session),
				api<Chat[]>("chats", session),
			]);
			setChannels(groups);
			setChats(threads);
		}
		void load().catch((e) => report(failure(e)));
	}, [session, report]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: explicit reads invalidate the inbox revision
	useEffect(() => {
		let active = true;
		let timer: number;
		async function poll() {
			try {
				const rows = await api<InboxEvent[]>("notifications", session);
				if (active) setEvents(rows);
			} catch (e) {
				if (active) report(failure(e));
			} finally {
				if (active) timer = window.setTimeout(poll, 4000);
			}
		}
		void poll();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [session, report, revision]);
	const chat = chats.find((c) => c.id === selected);
	const channel = channels.find(
		(c) =>
			c.id ===
			(chat?.channel ??
				(selected ? selected.replace(/^channel\//, "") : "general")),
	);
	const inbox = selected === "inbox";
	const threads = chats.filter((c) => c.channel === channel?.id);
	async function markRead(id: string) {
		try {
			await api(`chats/${id}/read`, session, {});
			refresh((n) => n + 1);
		} catch (e) {
			report(failure(e));
		}
	}
	return (
		<div id="workspace">
			<WorkspaceNav
				channels={channels}
				chats={chats}
				events={events}
				selected={selected}
				category={channel?.id}
				markRead={markRead}
			>
				<details>
					<summary>New category</summary>
					<form
						method="post"
						onSubmit={submit(async (form) => {
							const name = String(new FormData(form).get("name") ?? "").trim();
							const { id } = await api<{ id: string }>("channels", session, {
								name,
							});
							setChannels((list) => [...list, { id, name }]);
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
			</WorkspaceNav>
			{inbox ? (
				<section className="pane inbox-pane">
					<div className="pane-head">
						<p className="eyebrow">Inbox</p>
						<h1>Notifications</h1>
					</div>
					<div className="pane-scroll">
						<p className="hint">Replies and deliveries, newest first.</p>
						{events?.length === 0 && <p className="empty">No replies yet.</p>}
						<ul className="items">
							{events?.map((e) => (
								<li key={e.request}>
									<a href={`#${e.chat}`} onClick={() => void markRead(e.chat)}>
										<small>
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
			) : chat && channel ? (
				<Conversation
					key={chat.id}
					chat={chat}
					channel={channel}
					markRead={
						events?.some((e) => e.chat === chat.id && e.unread)
							? () => void markRead(chat.id)
							: undefined
					}
					session={session}
					drafts={drafts.current}
					rename={async (title) => {
						const saved = await api<{ title: string }>(
							`chats/${chat.id}/rename`,
							session,
							{ title },
						);
						setChats((list) =>
							list.map((c) =>
								c.id === chat.id ? { ...c, title: saved.title } : c,
							),
						);
					}}
					report={report}
				/>
			) : channel ? (
				<section className="pane category-pane">
					<div className="pane-head">
						<p className="eyebrow">Category</p>
						<h1>{channel.name}</h1>
					</div>
					<div className="pane-scroll">
						<h2 className="section-title">
							Threads <span>{threads.length}</span>
						</h2>
						{threads.length === 0 && (
							<p className="empty">No threads yet. Start one below.</p>
						)}
						<ul className="items">
							{threads.map((c) => (
								<li key={c.id}>
									<a href={`#${c.id}`} onClick={() => void markRead(c.id)}>
										{c.title}
									</a>
								</li>
							))}
						</ul>
					</div>
					<form
						key={channel.id}
						id="create"
						method="post"
						onSubmit={submit(async (form) => {
							const text = String(new FormData(form).get("text") ?? "");
							if (!text.trim()) return;
							const key = `start/${channel.id}`;
							const draft = requestFor(text, drafts.current.get(key) ?? null);
							drafts.current.set(key, draft);
							const thread = await api<Chat>("chats", session, {
								...draft,
								channel: channel.id,
							});
							drafts.current.delete(key);
							setChats((list) => [
								thread,
								...list.filter((c) => c.id !== thread.id),
							]);
							if (form.isConnected) location.hash = thread.id;
						})}
					>
						<label htmlFor="first-message">New thread in {channel.name}</label>
						<textarea
							id="first-message"
							name="text"
							placeholder="Write the first message…"
							onChange={(e) => {
								const key = `start/${channel.id}`;
								if (e.target.value)
									drafts.current.set(
										key,
										requestFor(e.target.value, drafts.current.get(key) ?? null),
									);
								else drafts.current.delete(key);
							}}
							defaultValue={
								drafts.current.get(`start/${channel.id}`)?.text ?? ""
							}
							rows={3}
							maxLength={8000}
							disabled={busy}
							required
						/>
						<button type="submit" disabled={busy}>
							Send message
						</button>
					</form>
				</section>
			) : (
				<section>
					<h1>{channels.length ? "Not found" : "Opening workspace…"}</h1>
				</section>
			)}
		</div>
	);
}
function App() {
	const [session, setSession] = useState("");
	const [notice, report] = useState("");
	const { busy, submit } = useSubmit(report);
	return (
		<>
			{!session && (
				<header>
					<span className="mark" aria-hidden="true">
						R
					</span>
					rothcold-agent <span className="sub">Hermes</span>
				</header>
			)}
			<main className={session ? "workspace-main" : undefined}>
				{session ? (
					<Workspace session={session} report={report} />
				) : (
					<section id="gate">
						<p className="eyebrow">Private workspace</p>
						<h1>rothcold-agent</h1>
						<p>Enter your owner token to open your workspace.</p>
						<form
							method="post"
							onSubmit={submit(async (form) => {
								const token = new FormData(form).get("token");
								form.reset();
								const auth = await api<{ session: string }>(
									"login",
									undefined,
									{ token },
								);
								setSession(auth.session);
							})}
						>
							<label htmlFor="token">Owner token</label>
							<input
								id="token"
								name="token"
								type="password"
								required
								maxLength={512}
								autoComplete="off"
							/>
							<button type="submit" disabled={busy}>
								Open workspace
							</button>
						</form>
					</section>
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
