// Joint acceptance: the NORMAL Web UI originates the file, the iPhone UI returns it.
// Run using script/test-noise-joint on an Apple silicon Mac with an iOS simulator runtime.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash, createPublicKey, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_DIR);
const { choose, freePort, listen, publicIngress, ready, signIn } = require('./browser-noise.cjs');

async function run() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rothcold-joint-'));
  const actors = [];
  let ingress, browser;
  try {
    const certPath = path.join(dir, 'root.crt'), keyPath = path.join(dir, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
    const cert = await readFile(certPath), webPort = await freePort(), wsPort = await freePort();
    ingress = publicIngress({ cert, key: await readFile(keyPath) }, webPort);
    const origin = `https://127.0.0.1:${await listen(ingress.edge)}`;
    const owner = randomBytes(32).toString('hex'), bridge = randomBytes(32).toString('hex');
    const addr = `127.0.0.1:${wsPort}`;
    const env = { ROTHCOLD_DATA_DIR: path.join(dir, 'data'), ROTHCOLD_NOISE_NATIVE_BIND: '127.0.0.1:0', ROTHCOLD_NOISE_WS_BIND: addr, ROTHCOLD_NOISE_WS_HOST: addr, ROTHCOLD_NOISE_WS_ORIGIN: origin, ROTHCOLD_AGENT_OWNER_TOKEN: owner, ROTHCOLD_AGENT_ADAPTER_TOKEN: bridge };
    const bin = 'server/target/debug/rothcold-agent';
    const pin = execFileSync(bin, ['noise-pin'], { env, encoding: 'utf8' }).trim();
    const server = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'inherit'] }); actors.push(server);
    const startup = await ready(server, addr);
    const native = startup.match(/native Noise listening on (127\.0\.0\.1:\d+)/)?.[1]; assert(native);
    const config = path.join(dir, 'web.json');
    await writeFile(config, JSON.stringify({ defaultBackend: 'joint', backends: { joint: { label: 'Joint fixture', port: wsPort } } }));
    const web = spawn(process.execPath, ['web/server.mjs'], { env: { ROTHCOLD_WEB_CONFIG: config, ROTHCOLD_WEB_PORT: String(webPort), ROTHCOLD_WEB_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'inherit'] }); actors.push(web);
    await ready(web, origin);
    const spki = createHash('sha256').update(createPublicKey(cert).export({ type: 'spki', format: 'der' })).digest('base64');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    const businessHTTP = [];
    page.on('request', req => { if (/^\/((api|adapter|connection)\/)/.test(new URL(req.url()).pathname)) businessHTTP.push(req.url()); });
    await page.goto(origin); await choose(page, 'joint', pin); await signIn(page, owner, 'Joint browser');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    await page.getByLabel('Owner avatar image').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: 'Remove Owner avatar' }).waitFor();
    await page.goto(`${origin}/#channel/general`);
    const draft = page.locator('#create [contenteditable=true]');
    await draft.fill('Received files');
    const data = randomBytes(98345);
    for (const item of [{ name: 'download-only.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }, { name: 'ios-cross-client.bin', mimeType: 'application/octet-stream', buffer: data }]) {
      await page.getByLabel('Choose attachments').setInputFiles(item);
      await page.getByRole('list', { name: 'Pending attachments' }).getByText(item.name, { exact: true }).waitFor();
    }
    await draft.press('Enter'); await page.waitForURL(/#[a-f0-9-]{36}$/);
    const thread = new URL(page.url()).hash.slice(1);
    async function adapter(op, msg) {
      const response = await fetch(`http://127.0.0.1:8766/adapter/${op}`, { method:'POST', headers: { Origin:'http://127.0.0.1:8766', Authorization:`Bearer ${bridge}`, 'Content-Type':'application/json' }, body:JSON.stringify(msg) });
      assert.equal(response.status, 200, op); return response.json();
    }
    await adapter('connect', {}); assert.equal((await adapter('claim', {})).id, thread);
    await adapter('admission', {id: thread, accepted:true});
    await adapter('final', {id: thread, chat: thread, text:'Simulator final reply'});
    await page.getByText('Simulator final reply', {exact:true}).waitFor();
    // Reuse the same black-box UI suite as the iOS lane, but WITHOUT its native file seeder.
    // The only source for both staged turn files and the owner avatar here is Chromium.
    const ui = spawn('python3', ['-B', '-c', 'from pathlib import Path; import os,sys;sys.path.insert(0,"tests");from ios_ingress import UI_TRANSFER,simulator_test;simulator_test(sys.argv[1], {k:os.environ[k] for k in ("IOS_NOISE_TEST_ADDRESS","IOS_NOISE_TEST_PIN","IOS_NOISE_TEST_OWNER")}, Path(sys.argv[2]), only_testing=UI_TRANSFER)', process.argv[2], process.argv[3]], { env:{...process.env, IOS_NOISE_TEST_ADDRESS:native, IOS_NOISE_TEST_PIN:pin, IOS_NOISE_TEST_OWNER:owner}, stdio:['ignore','inherit','inherit'] });
    const [code] = await once(ui, 'exit'); assert.equal(code, 0, 'iPhone UI suite');
    // A long-running UI test may leave the browser on an expired link. Reconnect deliberately.
    if (await page.getByRole('button', {name:'Reconnect',exact:true}).isVisible()) await page.getByRole('button', {name:'Reconnect',exact:true}).click();
    assert.equal(new URL(page.url()).hash.slice(1), thread, 'browser stayed in the original thread');
    const turn = page.locator('.user-turn').filter({hasText:'Queued from iPhone simulator'});
    const returned = turn.getByRole('button', {name:'Download ios-cross-client.bin'});
    await returned.waitFor(); const downloaded = page.waitForEvent('download'); await returned.click();
    const delivered = await downloaded; const bytes = await readFile(await delivered.path()); assert.deepEqual(bytes, data);
    assert.deepEqual(businessHTTP, []);
    const receipt = { thread, size:data.length, sha256:createHash('sha256').update(bytes).digest('hex'), source:'Chromium WSS → simulator Files → new iOS turn → Chromium download', httpBusinessRequests:businessHTTP.length };
    await writeFile(path.join(process.argv[3], 'joint-result.json'), JSON.stringify(receipt)+'\n'); console.log(JSON.stringify(receipt));
  } finally {
    await browser?.close(); ingress?.close();
    for (const proc of actors.reverse()) if(proc.exitCode === null && proc.signalCode === null) { const ended = once(proc,'exit'); proc.kill(); await ended; }
    await rm(dir,{recursive:true,force:true});
  }
}
run().catch(error => { console.error(error); process.exitCode=1; });
