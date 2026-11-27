import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";

const loopback = new Set(["127.0.0.1", "[::1]"]);
const maxBody = 64 * 1024 - 1;
const maxUpload = 25 * 1024 * 1024;
const maxAvatar = 5 * 1024 * 1024;
const transferLimits = { upload: 2, download: 8 };
const activeTransfers = { upload: 0, download: 0 };
const safeMedia = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"video/mp4",
	"video/quicktime",
	"video/webm",
	"video/ogg",
	"audio/mpeg",
	"audio/wav",
	"audio/flac",
	"audio/ogg",
	"audio/mp4",
	"audio/aac",
	"audio/webm",
]);

function address(value) {
	try {
		if (typeof value !== "string" || !/^https?:\/\/[\x21-\x7e]+$/.test(value))
			return null;
		const url = new URL(value);
		if (
			url.origin !== value ||
			(url.protocol !== "https:" && !loopback.has(url.hostname))
		)
			return null;
		return url;
	} catch {
		return null;
	}
}

async function readWebConfig() {
	const file = process.env.ROTHCOLD_WEB_CONFIG;
	let config = {};
	try {
		config = JSON.parse(
			await readFile(
				file ?? new URL("./rothcold-web.json", import.meta.url),
				"utf8",
			),
		);
	} catch (error) {
		if (file !== undefined || error.code !== "ENOENT")
			throw new Error("Cannot read web configuration");
	}
	if (
		!config ||
		Array.isArray(config) ||
		typeof config !== "object" ||
		(config.trustedApis !== undefined && !Array.isArray(config.trustedApis))
	) {
		throw new Error("Invalid web configuration");
	}
	return config;
}

function configuredTargets(selected, trustedApis) {
	const targets = new Map();
	for (const value of [selected, ...trustedApis]) {
		const url = address(value);
		if (!url) throw new Error("Invalid configured API origin");
		targets.set(value, url);
	}
	return targets;
}

async function readDefaultApi() {
	try {
		const raw = await readFile(
			new URL("./default-web-config.json", import.meta.url),
			"utf8",
		);
		return JSON.parse(raw).defaultApi;
	} catch {
		throw new Error("Cannot read default web configuration");
	}
}

async function configuration() {
	const config = await readWebConfig();
	const selected =
		process.env.ROTHCOLD_API_URL ??
		config.defaultApi ??
		(await readDefaultApi());
	const targets = configuredTargets(selected, config.trustedApis ?? []);
	const port = Number(process.env.ROTHCOLD_WEB_PORT ?? 8765);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("Invalid web port");
	const origin = address(
		process.env.ROTHCOLD_WEB_ORIGIN ?? `http://127.0.0.1:${port}`,
	);
	if (!origin) throw new Error("Invalid web origin");
	return { selected, targets, origin, port };
}

const { selected, targets, origin, port } = await configuration();
const assets = new Map();
for (const [path, file, type] of [
	["/", "index.html", "text/html; charset=utf-8"],
	["/app.js", "app.js", "text/javascript; charset=utf-8"],
	["/app.css", "app.css", "text/css; charset=utf-8"],
	["/brand/icon-dark.svg", "brand/icon-dark.svg", "image/svg+xml"],
	["/brand/icon-light.svg", "brand/icon-light.svg", "image/svg+xml"],
]) {
	try {
		assets.set(path, {
			body: await readFile(new URL(`./dist/${file}`, import.meta.url)),
			type,
		});
	} catch {
		throw new Error("Build the web app before starting it");
	}
}

const secure = origin.protocol === "https:";
function scopeHash(target) {
	return createHash("sha256")
		.update(`${origin.origin}\n${target.origin}`)
		.digest("hex");
}
const scopedTargets = new Map(
	[...targets.values()].map((target) => [scopeHash(target), target]),
);
function cookieName(target) {
	return `${secure ? "__Host-" : ""}rothcold_${scopeHash(target)}`;
}
function cookie(res, name, value, age) {
	res.setHeader(
		"Set-Cookie",
		`${name}=${value}; Path=${secure ? "/" : "/api/"}; Max-Age=${age}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
	);
}
function session(req, name) {
	const values = (req.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`));
	const key = values.length === 1 ? values[0].slice(name.length + 1) : "";
	return /^[a-f0-9]{64}$/.test(key) ? key : "";
}

function proxy(target, path, method, body, bearer, forwarded = {}) {
	return new Promise((resolve, reject) => {
		const headers = { Accept: "application/json", ...forwarded };
		if (Buffer.isBuffer(body)) {
			headers["Content-Type"] ??= "application/json";
			headers["Content-Length"] = body.length;
		}
		if (bearer) headers.Authorization = `Bearer ${bearer}`;
		const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
			target,
			{
				path,
				method,
				headers,
				agent: false,
				rejectUnauthorized: true,
			},
			(response) => {
				if (response.statusCode >= 300 && response.statusCode < 400) {
					response.destroy();
					reject(new Error("Redirect refused"));
				} else resolve(response);
			},
		);
		const deadline = setTimeout(
			() => request.destroy(new Error("API timed out")),
			10_000,
		);
		request.once("close", () => clearTimeout(deadline));
		request.once("error", reject);
		if (body && !Buffer.isBuffer(body)) {
			const cancel = () => request.destroy(new Error("Upload interrupted"));
			body.once("error", cancel);
			request.once("close", () => {
				body.unpipe(request);
				body.off("error", cancel);
			});
			request.flushHeaders();
			body.pipe(request);
		} else request.end(body);
	});
}
async function bytes(stream, limit) {
	const chunks = [];
	let size = 0;
	for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
		size += chunk.length;
		if (size > limit) return null;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}
function json(res, value) {
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(value));
}
function fail(res, status, message) {
	res.statusCode = status;
	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.end(message);
}
async function responseJson(upstream) {
	if (
		upstream.statusCode !== 200 ||
		!["application/json", "application/json; charset=utf-8"].includes(
			upstream.headers["content-type"],
		)
	) {
		upstream.destroy();
		throw new Error("Invalid API response");
	}
	const body = await bytes(upstream, 4096);
	if (!body) {
		upstream.destroy();
		throw new Error("Invalid API response");
	}
	try {
		return JSON.parse(body.toString("utf8"));
	} catch (error) {
		throw new Error("Invalid API response", { cause: error });
	}
}
async function verify(target) {
	const info = await responseJson(await proxy(target, "/api/status", "GET"));
	if (info?.service !== "rothcold-agent" || info?.apiVersion !== 1)
		throw new Error("Unexpected API");
}

function apiMethod(path, method) {
	if (
		/^\/api\/(?:login|logout|attachments|profile\/sync|sessions\/[a-f0-9-]{36}\/revoke)$/.test(
			path,
		)
	)
		return method === "POST";
	if (/^\/api\/(?:me|sessions|notifications|slash-catalog)$/.test(path))
		return method === "GET";
	if (
		/^\/api\/(?:chats|channels|profile|chats\/[A-Za-z0-9_-]+\/turns)$/.test(
			path,
		)
	)
		return true;
	return (
		method === "POST" &&
		/^\/api\/chats\/[A-Za-z0-9_-]+\/(?:rename|move|read(?:\/[A-Za-z0-9_-]+)?|turns\/[A-Za-z0-9_-]+\/stop-waiting)$/.test(
			path,
		)
	);
}

async function withTransferSlot(res, kind, action) {
	if (activeTransfers[kind] >= transferLimits[kind]) {
		if (kind === "upload") res.setHeader("Connection", "close");
		return fail(res, 503, "Attachment transfers busy. Try again.");
	}
	activeTransfers[kind] += 1;
	try {
		return await action();
	} finally {
		activeTransfers[kind] -= 1;
	}
}

async function browserMedia(req, res, scope, suffix) {
	const target = scopedTargets.get(scope);
	if (!target) return fail(res, 404, "Not Found");
	const bearer = session(req, cookieName(target));
	if (!bearer) return fail(res, 401, "Sign in again.");
	const ranges = req.headersDistinct.range;
	if (ranges && ranges.length !== 1) return fail(res, 416, "Invalid Range.");
	return withTransferSlot(res, "download", () =>
		sendBrowserMedia(res, target, suffix, bearer, ranges?.[0]),
	);
}

async function sendBrowserMedia(res, target, suffix, bearer, range) {
	const upstream = await proxy(
		target,
		`/api/attachments/${suffix}`,
		"GET",
		undefined,
		bearer,
		range === undefined ? undefined : { Range: range },
	);
	const status = upstream.statusCode;
	const type = upstream.headers["content-type"];
	const disposition = upstream.headers["content-disposition"];
	if (status === 200 || status === 206) {
		const download =
			suffix.endsWith("/download") || type === "application/octet-stream";
		if (
			(!safeMedia.has(type) && type !== "application/octet-stream") ||
			!(download ? /^attachment;/ : /^(?:inline|attachment);/).test(
				disposition ?? "",
			)
		) {
			upstream.destroy();
			throw new Error("Unexpected attachment response");
		}
	} else if (type !== undefined && type !== "text/plain; charset=utf-8") {
		upstream.destroy();
		throw new Error("Unexpected attachment response");
	}
	res.statusCode = status;
	for (const key of [
		"content-type",
		"content-disposition",
		"content-length",
		"accept-ranges",
		"content-range",
	]) {
		if (upstream.headers[key] !== undefined)
			res.setHeader(key, upstream.headers[key]);
	}
	await pipeline(upstream, res);
}

async function browserUpload(req, res, target, path, bearer) {
	const type = req.headersDistinct["content-type"];
	if (type?.length !== 1 || req.headers["content-encoding"] !== undefined)
		return fail(res, 415, "Expected unencoded binary data.");
	const names = req.headersDistinct["x-rothcold-filename"];
	const purposes = req.headersDistinct["x-rothcold-purpose"];
	const purpose = purposes?.[0] ?? "turn";
	if (
		names?.length !== 1 ||
		(purposes && purposes.length !== 1) ||
		(purpose !== "turn" && purpose !== "avatar")
	)
		return fail(res, 400, "Invalid attachment headers.");
	const limit = purpose === "avatar" ? maxAvatar : maxUpload;
	const length = req.headers["content-length"];
	if (length !== undefined && Number(length) > limit) {
		res.setHeader("Connection", "close");
		return fail(res, 413, "Request too large.");
	}
	const headers = {
		"X-Rothcold-Filename": names[0],
		"X-Rothcold-Purpose": purpose,
		"Content-Type": type[0],
	};
	return withTransferSlot(res, "upload", () =>
		sendBrowserUpload(req, res, {
			target,
			path,
			bearer,
			headers,
			length,
			limit,
		}),
	);
}

async function sendBrowserUpload(
	req,
	res,
	{ target, path, bearer, headers, length, limit },
) {
	// The HTTP parser bounds a declared length; chunked uploads are checked before forwarding.
	const body = length === undefined ? await bytes(req, limit) : req;
	if (!body) {
		res.setHeader("Connection", "close");
		return fail(res, 413, "Request too large.");
	}
	if (length !== undefined) headers["Content-Length"] = length;
	const upstream = await proxy(target, path, "POST", body, bearer, headers);
	if (!req.complete) res.setHeader("Connection", "close");
	await forwardApiResponse(upstream, res);
}

function allowedBrowserRequest(req, method) {
	const originHeader = req.headersDistinct.origin;
	const site = req.headers["sec-fetch-site"];
	if (originHeader || method === "POST") {
		if (originHeader?.length !== 1 || originHeader[0] !== origin.origin)
			return false;
	}
	return (
		(site === undefined || site === "same-origin") &&
		req.headers.authorization === undefined
	);
}

async function browserApi(req, res, path, method) {
	if (!allowedBrowserRequest(req, method)) return fail(res, 403, "Forbidden");
	if (path === "/connection/config" && method === "GET")
		return json(res, { defaultApi: selected });
	const media =
		/^\/api\/media\/([a-f0-9]{64})\/attachments\/([a-f0-9-]{36}(?:\/download)?)$/.exec(
			path,
		);
	if (media && method === "GET")
		return browserMedia(req, res, media[1], media[2]);
	const choices = req.headersDistinct["x-rothcold-server"];
	const target = choices?.length === 1 && targets.get(choices[0]);
	if (!target)
		return fail(res, 403, "This server is not configured on this web host.");
	if (path === "/connection/check" && method === "GET") {
		await verify(target);
		return json(res, {
			verified: true,
			mediaBase: `/api/media/${scopeHash(target)}`,
		});
	}
	if (!apiMethod(path, method)) return fail(res, 404, "Not Found");
	return authorizedApi(req, res, { target, path, method });
}

async function authorizedApi(req, res, { target, path, method }) {
	const name = cookieName(target);
	const login = path === "/api/login";
	const bearer = login ? "" : session(req, name);
	if (!login && !bearer) return fail(res, 401, "Sign in again.");
	if (path === "/api/attachments")
		return browserUpload(req, res, target, path, bearer);
	let body;
	if (method === "POST") {
		const type = req.headersDistinct["content-type"];
		if (
			type?.length !== 1 ||
			type[0] !== "application/json" ||
			req.headers["content-encoding"] !== undefined
		)
			return fail(res, 415, "Expected JSON.");
		body = await bytes(req, maxBody);
		if (!body) return fail(res, 413, "Request too large.");
	}
	if (login) return browserLogin(res, target, body, name);
	const upstream = await proxy(target, path, method, body, bearer);
	return forwardApiResponse(upstream, res);
}

async function browserLogin(res, target, body, name) {
	await verify(target);
	const upstream = await proxy(target, "/api/login", "POST", body);
	if (upstream.statusCode !== 200) {
		upstream.destroy();
		if (upstream.statusCode === 401)
			return fail(res, 401, "Invalid owner token.");
		if (upstream.statusCode === 429)
			return fail(res, 429, "Too many attempts. Try again shortly.");
		if (upstream.statusCode === 400)
			return fail(res, 400, "Invalid login details.");
		throw new Error("Invalid login response");
	}
	const { session: key, device } = await responseJson(upstream);
	const age = device?.expires_at - Math.floor(Date.now() / 1000);
	if (
		typeof key !== "string" ||
		!/^[a-f0-9]{64}$/.test(key) ||
		!Number.isSafeInteger(age) ||
		age <= 0 ||
		age > 31 * 86400
	)
		throw new Error("Invalid login response");
	cookie(res, name, key, age);
	return json(res, {});
}

async function forwardApiResponse(upstream, res) {
	// Logout revokes the submitted bearer upstream. Neither logout nor a 401
	// may erase a newer cookie set by a concurrent login.
	const type = upstream.headers["content-type"];
	if (type !== "application/json" && type !== "text/plain; charset=utf-8") {
		upstream.destroy();
		throw new Error("Unexpected API response type");
	}
	res.statusCode = upstream.statusCode;
	res.setHeader("Content-Type", type);
	await pipeline(upstream, res);
}

async function serve(req, res) {
	res.setHeader(
		"Content-Security-Policy",
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
	);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	res.setHeader("Cache-Control", "no-store");
	const { url: path, method } = req;
	if (
		req.headersDistinct.host?.length !== 1 ||
		req.headers.host !== origin.host
	)
		return fail(res, 403, "Forbidden");
	if (method !== "GET" && method !== "POST")
		return fail(res, 405, "Method Not Allowed");
	if (path.startsWith("/api/") || path.startsWith("/connection/"))
		return browserApi(req, res, path, method);
	const asset = method === "GET" && assets.get(path);
	if (!asset) return fail(res, 404, "Not Found");
	res.setHeader("Content-Type", asset.type);
	res.end(asset.body);
}

createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
	serve(req, res).catch(() => {
		if (res.headersSent) res.destroy();
		else
			fail(
				res,
				502,
				"Could not verify or reach the configured Rothcold Agent API.",
			);
	});
}).listen(port, "127.0.0.1", () =>
	process.stdout.write(`Rothcold web listening for ${origin.origin}\n`),
);
