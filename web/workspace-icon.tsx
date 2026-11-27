const strokes = {
	workspace: "M3.5 3.5h13v13h-13z M3.5 8h13 M8 8v8.5",
	inbox: "M3 11l2-6h10l2 6v5H3z M3 11h4l1 2h4l1-2h4",
	settings:
		"M8.5 2.5h3l.5 2 1.2.7 2-.6 1.5 2.6-1.5 1.4v2.8l1.5 1.4-1.5 2.6-2-.6-1.2.7-.5 2h-3l-.5-2-1.2-.7-2 .6-1.5-2.6 1.5-1.4V8.6L3.3 7.2l1.5-2.6 2 .6L8 4.5z M12.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
	search: "M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M13 13l3.5 3.5",
	thread: "M4 4h12v9H9l-4 3v-3H4z M7 7.5h6m-6 2.5h4",
	close: "m5 5 10 10m0-10L5 15",
	back: "M16 10H4m0 0 5-5m-5 5 5 5",
	forward: "m8 5 5 5-5 5",
	plus: "M10 4v12M4 10h12",
	menu: "M3 5h14M3 10h14M3 15h14",
	attach: "M7 12l5.5-5.5a2 2 0 0 1 2.8 2.8l-7 7a3.5 3.5 0 0 1-5-5l7.5-7.5",
	send: "M3 4l14 6-14 6 2-6z M5 10h6",
	bold: "M6 4.5h4.5a2.75 2.75 0 0 1 0 5.5H6z M6 10h5a2.75 2.75 0 0 1 0 5.5H6z",
	italic: "M8.5 4.5h5 M6.5 15.5h5 M11 4.5 9 15.5",
	strike:
		"M4 10h12 M13.5 6.8c0-1.4-1.5-2.3-3.5-2.3s-3.3.9-3.3 2.1c0 1.4 1.3 2 3.3 2.5 M6.5 13.2c0 1.4 1.5 2.3 3.5 2.3s3.5-.9 3.5-2.3",
	orderedList:
		"M8.5 6h7.5 M8.5 10h7.5 M8.5 14h7.5 M4 5.5h1.2v3 M4 12.2h1.6L4 14.5h1.8",
	bulletList:
		"M8.5 6h7.5 M8.5 10h7.5 M8.5 14h7.5 M4.5 6h.1 M4.5 10h.1 M4.5 14h.1",
	quote: "M4.5 5v10 M8.5 6.5h7 M8.5 10h6 M8.5 13.5h5",
	code: "M7 6.5 3.5 10 7 13.5 M13 6.5 16.5 10 13 13.5",
	codeBlock: "M3.5 4.5h13v11h-13z M8 8 6 10l2 2 M12 8l2 2-2 2",
	format:
		"M3.5 13.5 6.8 5.5l3.3 8 M4.7 10.8h4.2 M16.5 13.5v-4.5a2.1 2.1 0 1 0-4.2 0v2.4a2.1 2.1 0 1 0 4.2 0 M3 16.5h14",
	hermes:
		"M10 2.5v15m-5-3.5h10M10 10C5.5 10 3 7.5 3 5c3.5 0 5.5 1.5 7 4 1.5-2.5 3.5-4 7-4 0 2.5-2.5 5-7 5z",
	owner: "M10 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M5 16v-1a5 4 0 0 1 10 0v1",
};

export function WorkspaceIcon({ name }: { name: keyof typeof strokes }) {
	return (
		<svg
			aria-hidden="true"
			className="icon"
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d={strokes[name]} />
		</svg>
	);
}
