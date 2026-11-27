import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { InboxEvent } from "./chat.ts";
import { Markdown } from "./markdown.tsx";

const preference = "rothcold.browserAlerts";
function available() {
	return window.isSecureContext && "Notification" in window;
}
export function foreground() {
	return (
		document.visibilityState === "visible" &&
		document.hasFocus() &&
		!document.querySelector("dialog[open]")
	);
}
function canNotify() {
	return available() && Notification.permission === "granted";
}

function showBrowserAlert(
	notices: Set<Notification>,
	id: string,
	chat: string,
) {
	const notice = new Notification("Rothcold Agent", {
		body: "You have a new message.",
		tag: `rothcold:${id}`,
	});
	notices.add(notice);
	notice.onclose = () => {
		notices.delete(notice);
	};
	notice.onclick = () => {
		if (!notices.delete(notice)) return;
		window.focus();
		document.querySelector<HTMLDialogElement>("dialog[open]")?.close();
		location.hash = chat;
		notice.close();
	};
}

function useAlertPreference(report: (message: string) => void) {
	const [enabled, setEnabled] = useState(
		() => canNotify() && localStorage.getItem(preference) === "on",
	);
	const disable = useCallback(() => {
		setEnabled(false);
		localStorage.removeItem(preference);
	}, []);
	async function togglePreference() {
		if (enabled) return disable();
		try {
			if ((await Notification.requestPermission()) === "granted") {
				localStorage.setItem(preference, "on");
				setEnabled(true);
			} else {
				report(
					"Notifications are off. To allow them, check this site's browser permissions.",
				);
			}
		} catch {
			report("Browser notifications are unavailable.");
		}
	}
	return { enabled, disable, togglePreference };
}

function useFreshReplies(enabled: boolean) {
	const known = useRef<Set<string> | null>(null);
	const fresh = useRef(new Set<string>());
	const capture = useCallback(
		(rows: InboxEvent[]) => {
			const previous = known.current;
			known.current = new Set(rows.map((entry) => entry.request));
			for (const entry of rows) {
				if (!entry.unread) fresh.current.delete(entry.request);
				else if (enabled && previous && !previous.has(entry.request))
					fresh.current.add(entry.request);
			}
		},
		[enabled],
	);
	return { fresh, capture };
}

export function useBrowserAlerts(report: (message: string) => void) {
	const { enabled, disable, togglePreference } = useAlertPreference(report);
	const { fresh, capture } = useFreshReplies(enabled);
	const notices = useRef(new Set<Notification>());
	useLayoutEffect(() => {
		const unread = fresh.current;
		const open = notices.current;
		return () => {
			unread.clear();
			for (const notice of open) {
				open.delete(notice);
				notice.close();
			}
		};
	}, [fresh]);
	const notify = useCallback(
		(id: string, chat: string) => {
			if (!fresh.current.delete(id) || !enabled || !canNotify()) return;
			try {
				showBrowserAlert(notices.current, id, chat);
			} catch {
				disable();
				report(
					"This browser cannot show desktop notifications. Your inbox still works.",
				);
			}
		},
		[fresh, enabled, disable, report],
	);
	function toggle() {
		fresh.current.clear();
		return togglePreference();
	}
	return { enabled, available: available(), toggle, fresh, capture, notify };
}

function replyVisible(
	el: HTMLElement,
	root: Element,
	chat: string,
	drawerOpen: boolean,
) {
	if (drawerOpen || !foreground() || location.hash.slice(1) !== chat)
		return false;
	const box = el.getBoundingClientRect();
	const pane = root.getBoundingClientRect();
	return (
		Math.min(box.bottom, pane.bottom, innerHeight) >
		Math.max(box.top, pane.top, 0)
	);
}

export function ReplyBody({
	text,
	id,
	chat,
	read,
	alert,
	drawerOpen,
	onRead,
	notify,
}: {
	text: string;
	id: string;
	chat: string;
	read: boolean;
	alert: boolean;
	drawerOpen: boolean;
	onRead: (id: string, chat: string) => Promise<boolean>;
	notify: (id: string, chat: string) => void;
}) {
	const body = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = body.current;
		const root = el?.closest("#turns");
		if (read || !el || !root) return;
		let timer: number;
		let active = true;
		let sending = false;
		const visible = () => replyVisible(el, root, chat, drawerOpen);
		async function recordVisibleReply() {
			if (!active || !visible()) return;
			sending = true;
			if (!(await onRead(id, chat)) && active) {
				sending = false;
				timer = window.setTimeout(check, 4000);
			}
		}
		function check() {
			clearTimeout(timer);
			if (!active || sending) return;
			if (!visible()) {
				if (alert) notify(id, chat);
				return;
			}
			timer = window.setTimeout(recordVisibleReply, 600);
		}
		const observer = new IntersectionObserver(check, { root });
		observer.observe(el);
		window.addEventListener("focus", check);
		window.addEventListener("blur", check);
		document.addEventListener("visibilitychange", check);
		return () => {
			active = false;
			clearTimeout(timer);
			observer.disconnect();
			window.removeEventListener("focus", check);
			window.removeEventListener("blur", check);
			document.removeEventListener("visibilitychange", check);
		};
	}, [id, chat, read, alert, drawerOpen, onRead, notify]);
	return (
		<div ref={body}>
			<Markdown text={text} />
		</div>
	);
}
