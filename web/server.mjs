import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";

const config = JSON.parse(
	await readFile(
		process.env.ROTHCOLD_WEB_CONFIG ??
			new URL("./default-web-config.json", import.meta.url),
		"utf8",
	),
);
const port = Number(process.env.ROTHCOLD_WEB_PORT ?? 8765);
const publicOrigin =
	process.env.ROTHCOLD_WEB_ORIGIN ?? `https://127.0.0.1:${port}`;
const origin = new URL(publicOrigin);
if (
	origin.protocol !== "https:" ||
	origin.origin !== publicOrigin ||
	!Number.isInteger(port) ||
	port < 1 ||
	port > 65535
)
	throw new Error(
		"Expected an exact public HTTPS origin and valid local web port",
	);

const targets = new Map();
const backends = [];
for (const [id, backend] of Object.entries(config.backends ?? {})) {
	if (
		!/^[a-z0-9-]{1,40}$/.test(id) ||
		!backend ||
		typeof backend.label !== "string" ||
		!backend.label.trim() ||
		backend.label.length > 80 ||
		!Number.isInteger(backend.port) ||
		backend.port < 1 ||
		backend.port > 65535 ||
		backend.port === port ||
		backend.port === 8766 ||
		targets.size >= 16
	)
		throw new Error("Invalid configured Noise backend");
	const host = backend.host ?? `127.0.0.1:${backend.port}`;
	if (
		typeof host !== "string" ||
		!/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::[0-9]{1,5})?$/.test(host)
	)
		throw new Error("Invalid configured Noise Host");
	const path = `/noise/${id}`;
	const scope = createHash("sha256")
		.update(`${id}\n${host}\n${backend.port}`)
		.digest("hex");
	targets.set(path, { host, port: backend.port });
	backends.push({ id, label: backend.label, path, scope });
}
if (!Object.hasOwn(config.backends ?? {}, config.defaultBackend))
	throw new Error("Missing configured default Noise backend");

const assets = new Map();
for (const [path, file, type] of [
	["/", "index.html", "text/html; charset=utf-8"],
	["/app.js", "app.js", "text/javascript; charset=utf-8"],
	["/app.css", "app.css", "text/css; charset=utf-8"],
	["/theme.js", "theme.js", "text/javascript; charset=utf-8"],
	["/brand/icon-dark.svg", "brand/icon-dark.svg", "image/svg+xml"],
	["/brand/icon-light.svg", "brand/icon-light.svg", "image/svg+xml"],
]) {
	assets.set(path, {
		type,
		body: await readFile(new URL(`./dist/${file}`, import.meta.url)),
	});
}
// This is public deployment configuration, never server status, discovery, a pin or a credential.
assets.set("/backends.json", {
	type: "application/json; charset=utf-8",
	body: JSON.stringify({ defaultBackend: config.defaultBackend, backends }),
});

const only = (req, key, value) => {
	const values = req.headersDistinct[key];
	return values?.length === 1 && values[0] === value;
};
const server = createServer(
	{ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 },
	(req, res) => {
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
		);
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		res.setHeader("Cache-Control", "no-store");
		const asset = req.method === "GET" && assets.get(req.url);
		if (!only(req, "host", origin.host)) res.writeHead(403).end();
		else if (asset)
			res.writeHead(200, { "Content-Type": asset.type }).end(asset.body);
		else res.writeHead(404).end();
	},
);

const deniedHeaders = [
	"cookie",
	"authorization",
	"proxy-authorization",
	"sec-websocket-protocol",
	"content-length",
	"transfer-encoding",
];
const reject = (socket, status) =>
	socket.end(
		`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
	);
let live = 0;
server.on("upgrade", (req, socket, head) => {
	socket.on("error", () => socket.destroy());
	const target = targets.get(req.url);
	const keys = req.headersDistinct["sec-websocket-key"];
	const key = keys?.[0];
	if (
		!target ||
		req.method !== "GET" ||
		!only(req, "host", origin.host) ||
		!only(req, "origin", origin.origin) ||
		!only(req, "sec-websocket-version", "13") ||
		!only(req, "upgrade", "websocket") ||
		keys?.length !== 1 ||
		!/^[A-Za-z0-9+/]{22}==$/.test(key) ||
		head.length ||
		deniedHeaders.some((name) => req.headersDistinct[name])
	) {
		reject(socket, "403 Forbidden");
		return;
	}
	if (live >= 24) {
		reject(socket, "503 Service Unavailable");
		return;
	}
	live++;
	const upstream = request({
		host: "127.0.0.1",
		port: target.port,
		path: "/noise",
		method: "GET",
		agent: false,
		maxHeaderSize: 4096,
		headers: {
			Host: target.host,
			Origin: req.headers.origin,
			Upgrade: "websocket",
			Connection: "Upgrade",
			"Sec-WebSocket-Version": "13",
			"Sec-WebSocket-Key": key,
		},
	});
	let tunnel;
	const timeout = setTimeout(() => upstream.destroy(), 5000);
	socket.once("close", () => {
		live--;
		clearTimeout(timeout);
		upstream.destroy();
		tunnel?.destroy();
	});
	upstream.once("error", () => {
		if (!socket.destroyed) reject(socket, "502 Bad Gateway");
	});
	upstream.once("response", (res) => {
		res.destroy();
		if (!socket.destroyed) reject(socket, "502 Bad Gateway");
	});
	upstream.once("upgrade", (res, peer, first) => {
		clearTimeout(timeout);
		tunnel = peer;
		const accept = createHash("sha1")
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		if (
			socket.destroyed ||
			res.statusCode !== 101 ||
			!only(res, "upgrade", "websocket") ||
			!only(res, "sec-websocket-accept", accept) ||
			res.headersDistinct["sec-websocket-protocol"] ||
			res.headersDistinct["sec-websocket-extensions"] ||
			first.length
		) {
			peer.destroy();
			if (!socket.destroyed) reject(socket, "502 Bad Gateway");
			return;
		}
		peer.once("error", () => socket.destroy());
		peer.once("close", () => socket.destroy());
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		// No extensions are relayed; the Rust connector enforces binary/record limits and lifetimes.
		socket.pipe(peer).pipe(socket);
	});
	upstream.end();
});
server.listen(port, "127.0.0.1", () =>
	process.stdout.write(`Rothcold web listening for ${origin.origin}\n`),
);
