// Real regular-binary WSS with a disposable data directory and ephemeral TLS trust.
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { createHash, createPublicKey, randomBytes, randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const { checkServerIdentity } = require("node:tls");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { chromium } = require(process.env.PLAYWRIGHT_DIR || "playwright");
const { checkAppearanceSettings, themeScreens } = require("./browser-theme.cjs");

const root = path.resolve(__dirname, "..");
const adapter = "http://127.0.0.1:8766";
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const token = () => randomBytes(32).toString("hex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return server.address().port;
}
async function freePort() {
	const server = http.createServer();
	const port = await listen(server);
	await new Promise((resolve) => server.close(resolve));
	return port;
}
function ready(child, marker) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => done(new Error(`server did not report ${marker}`)), 8000);
		let output = "";
		function data(chunk) {
			output += chunk;
			if (output.includes(marker)) done();
		}
		function exit(code) { done(new Error(`server exited ${code}: ${output}`)); }
		function done(error) {
			clearTimeout(timeout);
			child.stdout.off("data", data);
			child.off("exit", exit);
			if (error) reject(error); else resolve(output);
		}
		child.stdout.on("data", data);
		child.once("exit", exit);
	});
}
function publicIngress(tls, webPort) {
	const sockets = new Set();
	const tunnels = new Map();
	const edge = https.createServer(tls, (req, res) => {
		const upstream = http.request({ port: webPort, host: "127.0.0.1", method: req.method, path: req.url, headers: req.headers }, (result) => {
			res.writeHead(result.statusCode, result.headers);
			result.pipe(res);
		});
		upstream.on("error", () => res.destroy());
		req.pipe(upstream);
	});
	edge.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	edge.on("upgrade", (req, socket, head) => {
		const upstream = http.request({ port: webPort, host: "127.0.0.1", method: req.method, path: req.url, headers: req.headers });
		upstream.on("response", (response) => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
		upstream.on("upgrade", (response, peer, first) => {
			let headers = "HTTP/1.1 101 Switching Protocols\r\n";
			for (let i = 0; i < response.rawHeaders.length; i += 2) headers += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
			socket.write(`${headers}\r\n`);
			if (first.length) socket.write(first);
			if (head.length) peer.write(head);
			tunnels.set(socket, { path: req.url, peer });
			socket.on("close", () => { tunnels.delete(socket); peer.destroy(); });
			socket.on("error", () => peer.destroy());
			peer.on("error", () => socket.destroy());
			peer.on("close", () => socket.destroy());
			socket.pipe(peer).pipe(socket);
		});
		upstream.on("error", () => socket.destroy());
		upstream.end();
	});
	return {
		edge,
		hold(path) {
			const last = Array.from(tunnels).filter(([, item]) => item.path === path).at(-1);
			assert(last, `No active TLS tunnel for ${path}`);
			const [socket, { peer }] = last;
			peer.pause();
			const drop = () => socket.destroy();
			drop.resume = () => peer.resume();
			return drop;
		},
		close: () => { for (const socket of sockets) socket.destroy(); edge.close(); },
	};
}
function checkUpgrade(origin, cert, url, headers) {
	return new Promise((resolve, reject) => {
		const request = https.request(`${origin}${url}`, { ca: cert, servername: "", checkServerIdentity: (_, peer) => checkServerIdentity("127.0.0.1", peer), headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), ...headers } });
		request.on("response", (res) => { res.resume(); resolve(res.statusCode); });
		request.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
		request.on("error", reject);
		request.end();
	});
}
async function choose(page, backend, pin) {
	await page.getByLabel("Trusted backend").selectOption(backend);
	await page.getByLabel("Trusted Noise pin").fill(pin);
	await page.getByRole("button", { name: "Connect", exact: true }).click();
}
async function signIn(page, owner, name) {
	await page.getByLabel("Owner token").fill(owner);
	await page.getByLabel("Device name (optional)").fill(name);
	await page.getByRole("button", { name: "Open workspace" }).click();
	await page.getByRole("link", { name: "Settings", exact: true }).waitFor();
}
async function screenshots(page, label) {
	if (!process.env.SHOTS) return;
	for (const width of [1100, 375]) {
		await page.setViewportSize({ width, height: 820 });
		await themeScreens(page, `${label}-${width}`, [["h1"]]);
	}
	await page.setViewportSize({ width: 1100, height: 820 });
}

async function eventually(check, timeout = 6500) {
	const deadline = Date.now() + timeout;
	do {
		const value = await check();
		if (value) return value;
		await wait(60);
	} while (Date.now() < deadline);
	throw new Error("Timed out waiting for fixture state");
}

async function browserFixtures(dir, nativeCall, post, adapterToken) {
	const image = path.join(dir, "sample.png");
	await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
	const wave = path.join(dir, "sample.wav");
	const wav = Buffer.alloc(44 + 40960);
	wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
	wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
	wav.write("data",36); wav.writeUInt32LE(wav.length - 44,40);
	for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE((i % 240) * 8 - 960, i);
	await writeFile(wave, wav);
	async function pages(message) {
		const items = [];
		let after = null;
		do {
			const { page } = await nativeCall({ ...message, after });
			items.push(...page.items);
			after = page.next;
		} while (after !== null);
		return items;
	}
	async function complete(id, text, commentary, chat = id) {
		assert.equal((await post("claim", {}))?.id, id, "adapter must claim the correlated real turn");
		await post("admission", { id, accepted: true });
		if (commentary) await post("update", { chat, turn: id, id: randomUUID(), kind: "commentary", text: commentary });
		await post("final", { chat, id, text });
	}
	async function avatar(bytes) {
		const response = await fetch(`${adapter}/adapter/avatar`, { method: "POST", headers:{ Origin: adapter, Authorization:`Bearer ${adapterToken}`, "Content-Type":"image/png", "X-Rothcold-Filename":"fixture.png" }, body: bytes });
		assert.equal(response.status, 201);
		return response.json();
	}
	return { image, wave, nativeCall, post, pages, complete, avatar, eventually };
}

async function main() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "rothcold-browser-noise-"));
	const children = [];
	let browser;
	let ingress;
	try {
		const certPath = path.join(dir, "cert.pem");
		const keyPath = path.join(dir, "key.pem");
		execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
		const cert = await readFile(certPath);
		const spki = createHash("sha256").update(createPublicKey(cert).export({ type: "spki", format: "der" })).digest("base64");
		const webPort = await freePort();
		const wsPort = await freePort();
		ingress = publicIngress({ cert, key: await readFile(keyPath) }, webPort);
		const origin = `https://127.0.0.1:${await listen(ingress.edge)}`;
		const owner = token();
		const adapterToken = token();
		const binary = process.env.ROTHCOLD_BROWSER_SERVER || path.join(root, "server/target/debug/rothcold-agent");
		const env = { ROTHCOLD_DATA_DIR: path.join(dir, "workspace"), ROTHCOLD_NOISE_NATIVE_BIND: "127.0.0.1:0", ROTHCOLD_NOISE_WS_BIND: `127.0.0.1:${wsPort}`, ROTHCOLD_NOISE_WS_HOST: `127.0.0.1:${wsPort}`, ROTHCOLD_NOISE_WS_ORIGIN: origin, ROTHCOLD_AGENT_OWNER_TOKEN: owner, ROTHCOLD_AGENT_ADAPTER_TOKEN: adapterToken };
		const pin = execFileSync(binary, ["noise-pin"], { env, encoding: "utf8" }).trim();
		assert.match(pin, /^[0-9a-f]{64}$/);
		const server = spawn(binary, [], { env, stdio: ["ignore", "pipe", "inherit"] });
		children.push(server);
		const startup = await ready(server, `127.0.0.1:${wsPort}`);
		const nativeAddress = startup.match(/native Noise listening on (127\.0\.0\.1:\d+)/)?.[1];
		assert(nativeAddress);
		const driver = process.env.ROTHCOLD_BROWSER_DRIVER || path.join(root, "server/target/debug/examples/noise-fixture");
		let native;
		let out;
		async function nativeCall(message) {
			if (!native) {
				native = spawn(driver, [nativeAddress, pin], { env: {}, stdio: ["pipe", "pipe", "inherit"] });
				children.push(native);
				out = createInterface({ input: native.stdout })[Symbol.asyncIterator]();
			}
			native.stdin.write(`${JSON.stringify(message)}\n`);
			const line = await out.next();
			assert(!line.done, "native fixture disconnected");
			const reply = JSON.parse(line.value);
			assert.notEqual(reply.type, "error", reply.message);
			return reply;
		}
		const post = async (route, body) => {
			const response = await fetch(`${adapter}/adapter/${route}`, { method: "POST", headers: { Origin: adapter, Authorization: `Bearer ${adapterToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const raw = await response.text();
			assert.equal(response.status, 200, raw);
			return JSON.parse(raw);
		};
		const config = path.join(dir, "web.json");
		// A second selector to the same responder validates connector scoping, not two-workspace integration.
		await writeFile(config, JSON.stringify({ defaultBackend: "a", backends: { a: { label: "Fixture A", port: wsPort }, alias: { label: "Fixture alias", port: wsPort } } }));
		const edge = spawn(process.execPath, [path.join(root, "web/server.mjs")], { env: { ROTHCOLD_WEB_CONFIG: config, ROTHCOLD_WEB_PORT: String(webPort), ROTHCOLD_WEB_ORIGIN: origin }, stdio: ["ignore", "pipe", "inherit"] });
		children.push(edge);
		await ready(edge, origin);
		for (const [url, headers] of [["/noise/missing", { Origin: origin }], ["/noise/a?target=other", { Origin: origin }], ["/noise/a", { Origin: "https://wrong.example" }], ["/noise/a", {}], ["/noise/a", { Origin: "null" }], ["/noise/a", { Origin: origin, Host: "bad.example" }], ["/noise/a", { Origin: origin, Cookie: "legacy=ignored" }], ["/noise/a", { Origin: origin, "Sec-WebSocket-Protocol": "x" }], ["/noise/a", { Origin: origin, Authorization: "Bearer synthetic" }]]) {
			assert.equal(await checkUpgrade(origin, cert, url, headers), 403);
		}
		assert.equal(await checkUpgrade(origin, cert, "/noise/a", { Origin: origin }), 101);
		if (process.env.SHOTS) await mkdir(process.env.SHOTS, { recursive: true });
		browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
		const primary = await browser.newContext({ viewport: { width: 1100, height: 820 } });
		const page = await primary.newPage();
		await page.addInitScript(() => {
			const revoke = URL.revokeObjectURL;
			window.revokedMedia = [];
			URL.revokeObjectURL = (uri) => { window.revokedMedia.push(uri); revoke(uri); };
		});
		const requests = [];
		const wires = [];
		const violations = [];
		const exceptions = [];
		page.on("request", (request) => requests.push(request.url()));
		page.on("websocket", (wire) => {
			const connection = { url: wire.url(), sent: 0, received: 0 };
			wires.push(connection);
			const received = (payload) => {
				if (!Buffer.isBuffer(payload) || payload.length < 1 || payload.length > 65535)
					violations.push(`Nonbinary or oversized WebSocket message (${payload.length})`);
			};
			wire.on("framesent", ({ payload }) => { received(payload); connection.sent++; });
			wire.on("framereceived", ({ payload }) => { received(payload); connection.received++; });
		});
		page.on("console", (msg) => { if (/Content Security Policy|violates.*policy/i.test(msg.text())) violations.push(msg.text()); });
		page.on("pageerror", (error) => exceptions.push(error.message));
		const pageResponse = await page.goto(origin);
		assert.equal(pageResponse.headers()["content-security-policy"], csp);
		await page.getByLabel("Trusted backend").waitFor();
		await screenshots(page, "noise-connect");
		await choose(page, "a", token());
		await page.getByRole("status").filter({ hasText: /Noise pin|secure connection closed/i }).waitFor();
		assert.equal(await page.getByLabel("Owner token").count(), 0);
		assert.equal(wires.at(-1).sent, 1, "wrong pin must not send status, token or key proof");
		await choose(page, "a", pin);
		await page.getByLabel("Owner token").waitFor();
		await screenshots(page, "noise-login");
		await signIn(page, owner, "Primary Noise browser");
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		await page.getByText("Primary Noise browser (this device)").waitFor();
		await screenshots(page, "noise-settings");
		await checkAppearanceSettings(page, origin, (gate) => choose(gate, "a", pin));
		const saved = await page.evaluate(() => new Promise((resolve, reject) => {
			const request = indexedDB.open("rothcold-noise-devices", 1);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const db = request.result;
				const all = db.transaction("devices").objectStore("devices").getAll();
				all.onsuccess = () => {
					const [entry] = all.result;
					resolve({ count: all.result.length, extractable: entry.privateKey.extractable, fields: Object.keys(entry).sort(), type: entry.privateKey.type, storage: JSON.stringify(localStorage), cookies: document.cookie });
					db.close();
				};
			};
		}));
		assert.deepEqual({ ...saved, storage: "" }, { count: 1, extractable: false, fields: ["id", "privateKey", "publicKey"], type: "private", storage: "", cookies: "" });
		assert(!saved.storage.includes(owner));
		await page.reload();
		await page.getByText("Primary Noise browser (this device)").waitFor();
		await page.getByRole("button", { name: "Change server" }).click();
		await choose(page, "alias", pin);
		await page.getByLabel("Owner token").waitFor();
		await page.getByRole("button", { name: "Change server" }).click();
		await choose(page, "a", pin);
		await page.getByRole("link", { name: "Settings", exact: true }).waitFor();

		// The normal workspace submits a durable turn and attachment audit across multiple chunks.
		await page.goto(`${origin}/#channel/general`);
		const composer = page.locator("#create [contenteditable=true]");
		const picker = page.getByLabel("Choose attachments");
		await picker.waitFor({state:"attached"});
		const attachmentsPath = path.join(env.ROTHCOLD_DATA_DIR, "attachments");
		const attachmentEntries = async () => (await readdir(attachmentsPath)).sort();
		const beforeCancel = await attachmentEntries();
		const currentWires = wires.length;
		const heldUpload = ingress.hold("/noise/a");
		await picker.setInputFiles({name:"cancel.bin",mimeType:"application/octet-stream",buffer:randomBytes(96*1024)});
		await eventually(async () => (await attachmentEntries()).some((name) => name.startsWith(".noise-upload-")));
		await page.getByRole("button", {name:"Remove cancel.bin"}).click();
		heldUpload.resume();
		await eventually(async () => JSON.stringify(await attachmentEntries()) === JSON.stringify(beforeCancel));
		assert.equal(wires.length, currentWires, "explicit cancel should keep the verified connection");
		await picker.setInputFiles({name:"too-large.bin",mimeType:"application/octet-stream",buffer:Buffer.alloc(25*1024*1024+1)});
		await page.getByRole("status").filter({hasText:"25 MiB"}).waitFor();
		assert.deepEqual(await attachmentEntries(), beforeCancel);
		await post("slash-catalog", { catalog: { commands: ["status"], skills: ["synthetic-skill"] } });
		await composer.pressSequentially("/");
		const menu = page.getByRole("listbox", { name: "Gateway suggestions" });
		await menu.getByRole("option", { name: "/status", exact: true }).waitFor();
		await menu.getByRole("option", { name: "/synthetic-skill", exact: true }).click();
		assert.match(await composer.innerText(), /^\/synthetic-skill\s*$/);
		assert.equal(new URL(page.url()).hash, "#channel/general", "choosing a command must only change the draft");
		await composer.fill("Noise browser fixture message");
		const content = Buffer.concat([Buffer.from("<script>throw new Error('inline HTML')</script>"), randomBytes(2 * 32768 + 19)]);
		await page.getByLabel("Choose attachments").setInputFiles({ name: "fixture.html", mimeType: "text/html", buffer: content });
		await page.getByRole("list", { name: "Pending attachments" }).getByText("fixture.html", { exact: true }).waitFor();
		await composer.press("Enter");
		await page.waitForURL(/#[a-f0-9-]{36}$/);
		await page.locator(".user-turn .message").getByText("Noise browser fixture message", { exact: true }).waitFor();
		const thread = new URL(page.url()).hash.slice(1);
		assert.match(thread, /^[a-f0-9-]{36}$/);
		const files = page.getByRole("list", { name: "Message attachments" });
		await files.getByText("fixture.html", { exact: true }).waitFor();
		assert.equal(await files.locator("img,iframe,object,video,audio").count(), 0);
		const downloaded = page.waitForEvent("download");
		await files.getByRole("button", { name: "Download fixture.html" }).click();
		const file = await downloaded;
		assert.equal(file.suggestedFilename(), "fixture.html");
		assert.deepEqual(await readFile(await file.path()), content);

		await post("connect", {});
		assert.equal((await post("claim", {})).id, thread);
		await post("admission", { id: thread, accepted: true });
		await post("update", { chat: thread, turn: thread, id: "browser-approval", kind: "commentary", text: "Browser approval fixture" });
		const cards = { approvals: [{ chat: thread, id: "browser-approval", choices: ["once", "deny"] }] };
		assert.equal(await post("claim", cards), null);
		await page.getByRole("button", { name: "Approve once", exact: true }).click();
		assert.equal((await post("claim", cards)).choice, "once");
		const manual = { approvals:[{chat:thread,id:"manual-approval",choices:["deny"]}] };
		await post("update", {chat:thread,turn:thread,id:"manual-approval",kind:"progress",text:"Restricted approval fixture"});
		assert.equal(await post("claim", manual), null);
		await post("slash-catalog", { catalog:{ commands:["approve","deny","status"],skills:[] } });
		await page.locator(".approval-prompt").getByText("Restricted approval fixture", {exact:true}).waitFor();
		assert.equal(await page.getByRole("button", {name:"Approve once",exact:true}).count(),0);
		await page.getByRole("button", {name:"Deny",exact:true}).waitFor();
		const controls = page.locator("#compose [contenteditable=true]");
		await controls.pressSequentially("/");
		const suggestions = page.getByRole("listbox", {name:"Gateway suggestions"});
		await suggestions.getByRole("option", {name:"/deny",exact:true}).waitFor({timeout:5500});
		assert.equal(await suggestions.getByRole("option", {name:"/approve",exact:true}).count(), 0);
		await suggestions.getByRole("option", {name:"/deny",exact:true}).click();
		assert.equal(await post("claim", manual), null, "suggestion selection must not deliver a decision");
		await controls.press("Enter");
		const denied = await eventually(async () => (await post("claim", manual)) || null);
		assert.equal(denied.approval, "manual-approval");
		assert.equal(denied.choice, "deny");
		await post("final", { id: thread, chat: thread, text: "Final via the fixture adapter." });
		await page.getByText("Final via the fixture adapter.", { exact: true }).waitFor();
		await post("push", { id: randomUUID(), chat: thread, text: "Noise fixture pushed reply." });
		await page.getByText("Noise fixture pushed reply.", { exact: true }).waitFor();
		await screenshots(page, "noise-thread");

		// A concurrent native device queues an offline reply to this already settled thread.
		// There is no new final, inbox event, hash navigation, or browser reload to wake the UI.
		assert.equal((await nativeCall({ type: "login_native", owner_token: owner, name: "Independent disposable observer" })).type, "native_login");
		const beforeRemote = await nativeCall({type:"inbox"});
		const oldThreadUrl = page.url();
		const oldWireCount = wires.length;
		const remoteBytes = randomBytes(32768 + 79);
		const remote = await nativeCall({type:"fixture_upload",purpose:"turn",filename:"native-reply.bin",bytes:[...remoteBytes]});
		assert.equal(remote.type, "upload_complete");
		const remoteId = randomUUID();
		const remoteText = "Queued offline from another device";
		assert.equal((await nativeCall({type:"send_turn",chat:thread,message:{id:remoteId,text:remoteText,attachments:[remote.attachment.id]}})).fresh,true);
		const remoteTurn = page.locator(".turn").filter({hasText:remoteText});
		await remoteTurn.getByText(remoteText, {exact:true}).waitFor({timeout:12000});
		await remoteTurn.getByText("Queued. Waiting to send to Hermes.", {exact:true}).waitFor();
		const nativeDownload = page.waitForEvent("download");
		await remoteTurn.getByRole("button", {name:"Download native-reply.bin"}).click();
		assert.deepEqual(await readFile(await (await nativeDownload).path()), remoteBytes);
		assert.equal(page.url(), oldThreadUrl);
		assert.equal(wires.length, oldWireCount);
		const afterRemote = await nativeCall({type:"inbox"});
		assert.deepEqual(afterRemote.page.items.map(({request}) => request), beforeRemote.page.items.map(({request}) => request));
		// Settle this synthetic turn only after proving that no adapter delivery was needed.
		assert.equal((await post("claim", {})).id, remoteId);
		await post("admission", {id:remoteId,accepted:true});
		await post("final", {id:remoteId,chat:thread,text:"Native fixture turn settled for the next test."});
		await page.getByText("Native fixture turn settled for the next test.", {exact:true}).waitFor();
		console.log("Already-open settled thread refreshed an offline typed native append and downloaded its complete attachment without Inbox, reload, or reconnect");

		await page.getByRole("link", { name: "Settings", exact: true }).click();
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
		await page.getByLabel("Owner avatar image").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png });
		await page.getByRole("button", { name: "Remove Owner avatar" }).waitFor();
		await page.goto(`${origin}/#${thread}`);
		const reply = page.locator("#compose [contenteditable=true]");
		const avatar = page.locator(".user-turn .owner-avatar img").first();
		await avatar.waitFor();
		const oldURL = await avatar.getAttribute("src");
		assert.match(oldURL, /^blob:/);
		const submitted = "The browser must not repeat this change across transport loss.";
		await reply.fill(submitted);
		const send = await ingress.hold("/noise/a");
		await reply.press("Enter");
		async function history() {
			const items = [];
			let after = null;
			do {
				const { page } = await nativeCall({ type: "history", chat: thread, after });
				items.push(...page.items);
				after = page.next;
			} while (after !== null);
			return items;
		}
		await new Promise((resolve, reject) => {
			const deadline = Date.now() + 5000;
			async function attempt() {
				try {
					if ((await history()).some((item) => item.text === submitted)) resolve();
					else if (Date.now() > deadline) reject(new Error("Held reply did not reach the real workspace"));
					else setTimeout(attempt, 70);
				} catch (error) { reject(error); }
			}
			void attempt();
		});
		send();
		await page.getByRole("heading", { name: "Connection lost" }).waitFor();
		await page.getByRole("status").filter({ hasText: "may have committed" }).waitFor();
		await page.waitForFunction((url) => window.revokedMedia.includes(url), oldURL);
		assert.equal(await avatar.count(), 0, "old media must not remain displayed");
		const count = wires.length;
		await wait(4400);
		assert.equal(wires.length, count, "polling or queued work reconnected without intent");
		await page.getByRole("button", { name: "Reconnect", exact: true }).click();
		await page.locator(".user-turn .message").getByText(submitted, { exact: true }).waitFor();
		assert.equal(wires.length, count + 1);
		const receipts = (await history()).filter((item) => item.text === submitted);
		assert.equal(receipts.length, 1);
		assert.equal((await post("claim", {})).id, receipts[0].id);
		await post("admission", { id: receipts[0].id, accepted: true });
		await post("connect", {});
		await page.getByText("Stop waiting and continue in this thread", { exact: true }).click();
		await page.getByRole("button", { name: "Confirm and continue", exact: true }).click();
		await page.getByText(/Stopped waiting/i).waitFor();
		assert.equal((await history()).find((item) => item.id === receipts[0].id).state, "released");
		await page.getByRole("button", { name: "Archive thread", exact: true }).click();
		await page.getByRole("button", { name: "Restore thread", exact: true }).waitFor();
		assert.equal(await page.locator("#compose").count(), 0);
		assert.equal((await nativeCall({ type: "threads", include_archived: false })).page.items.some((item) => item.id === thread), false);
		await page.getByRole("button", { name: "Restore thread", exact: true }).click();
		await reply.waitFor();
		assert.equal((await nativeCall({ type: "threads", include_archived: false })).page.items.some((item) => item.id === thread), true);

		const other = await browser.newContext();
		const lost = await other.newPage();
		await lost.goto(origin);
		await choose(lost, "a", pin);
		await signIn(lost, owner, "Lost Noise browser");
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "Revoke Lost Noise browser" }).click();
		await lost.getByLabel("Owner token").waitFor({ timeout: 10000 });
		await lost.getByRole("status").filter({ hasText: "revoked" }).waitFor();
		await other.close();
		await page.getByRole("button", { name: "Sign out this device" }).click();
		await page.getByLabel("Owner token").waitFor();
		await page.reload();
		await page.getByLabel("Owner token").waitFor();
		for (const url of ["/api/me", "/api/media/attachments", "/connection/check", "/adapter/claim", "/noise/a"]) {
			const status = await new Promise((resolve, reject) => {
				https.get(`${origin}${url}`, { ca: cert }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
			});
			assert.equal(status, 404, url);
		}
		assert(requests.every((url) => url.startsWith("blob:") || (new URL(url).origin === origin && /^(?:\/|\/app\.(?:js|css)|\/theme\.js|\/backends\.json|\/brand\/[^/]+)$/.test(new URL(url).pathname))), JSON.stringify(requests));
		assert(wires.every((wire) => wire.url === `${origin.replace("https:", "wss:")}/noise/a` || wire.url.endsWith("/noise/alias")));
		assert(wires.some((wire) => wire.sent > 16 && wire.received > 16));
		assert.deepEqual(violations, []);
		assert.deepEqual(exceptions, []);
		const regression = await browser.newContext({ viewport:{width:1100,height:800}, serviceWorkers:"block" });
		await regression.addInitScript(() => {
			window.sentAlerts = [];
			// Headless Chromium with the disposable SPKI can report static permission as
			// denied even after the permission request returns granted. Model only the
			// OS notification boundary so the fixture exercises the app's routing/privacy.
			let permission = "default";
			window.Notification = new Proxy(Notification, {
				get(target, key, receiver) {
					if (key === "permission") return permission;
					if (key === "requestPermission") return async () => (permission = "granted");
					return Reflect.get(target, key, receiver);
				},
				construct(_target, [title, options]) {
					const notice = {title, ...options, close() { this.onclose?.(); }};
					window.sentAlerts.push(notice);
					return notice;
				},
			});
		});
		const legacy = await regression.newPage();
		legacy.setDefaultTimeout(11000);
		legacy.on("pageerror", (error) => exceptions.push(error.message));
		legacy.on("request", (request) => {
			if (/\/(?:api|adapter|connection)\//.test(new URL(request.url()).pathname)) violations.push(request.url());
		});
		await legacy.goto(origin);
		await choose(legacy, "a", pin);
		await signIn(legacy, owner, "Legacy coverage Noise browser");
		await require("./browser.cjs")(legacy, origin, await browserFixtures(dir, nativeCall, post, adapterToken));
		assert.deepEqual(exceptions, []);
		assert.deepEqual(violations, []);
		await regression.close();

		console.log("Chromium Noise passed: unchanged CSP, pinned binary WSS, device scoping and restore, full file bytes, real approval and final, avatar lease revocation, explicit reconnect without replay, archive, recovery, slash catalog, themes, device revocation and logout");
	} finally {
		await browser?.close();
		ingress?.close();
		await Promise.all(children.map(async (child) => { if (child.exitCode === null) { child.kill(); await Promise.race([once(child, "exit"), wait(1000)]); } }));
		await rm(dir, { recursive: true, force: true });
	}
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { choose, freePort, listen, publicIngress, ready, signIn };
