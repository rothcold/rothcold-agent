// Two independent normal servers; only the namespace-local WSS port is relayed.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash, createPublicKey, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const net = require('node:net');
const { createInterface } = require('node:readline');
const os = require('node:os');
const path = require('node:path');
const { choose, freePort, listen, publicIngress, ready, signIn } = require('./browser-noise.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const { themeScreens } = require('./browser-theme.cjs');

const root = path.resolve(__dirname, '..');
const token = () => randomBytes(32).toString('hex');
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit');
  child.kill();
  const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(deadline); }
};

function relay(endpoint, upstream) {
  const sockets = new Set();
  const listener = net.createServer((client) => {
    const peer = net.connect(upstream);
    for (const [left, right] of [[client, peer], [peer, client]]) {
      sockets.add(left);
      left.on('error', () => right.destroy());
      left.on('close', () => { sockets.delete(left); right.destroy(); });
    }
    client.pipe(peer).pipe(client);
  });
  const started = once(listener, 'listening');
  listener.listen(endpoint);
  return { listener, started, close() {
    for (const socket of sockets) socket.destroy();
    listener.close();
  }};
}

async function namespace() {
  const [binary, socket, parentNs] = process.argv.slice(3);
  const { readlink } = require('node:fs/promises');
  assert.notEqual(await readlink('/proc/self/ns/net'), parentNs, 'second server needs a distinct network namespace');
  const child = spawn(binary, [], {stdio:['ignore','pipe','inherit']});
  const port = Number(process.env.ROTHCOLD_NOISE_WS_BIND.split(':').at(-1));
  let bridge;
  const shutdown = async () => { bridge?.close(); await stop(child); };
  process.once('SIGTERM', () => void shutdown());
  try {
    await ready(child, `browser Noise listening on 127.0.0.1:${port}`);
    bridge = relay(socket, {host:'127.0.0.1',port});
    await bridge.started;
    console.log('Isolated WSS ready');
    await once(child, 'exit');
  } finally { await shutdown(); }
}

async function toggle(page) {
  await page.getByRole('link', {name:'Settings', exact:true}).click();
  await page.getByRole('button', {name:'Change server'}).click();
}
async function category(page, name) {
  const sidebar = page.getByRole('complementary', {name:'Workspace navigation'});
  await sidebar.getByText('New category', {exact:true}).click();
  await sidebar.getByLabel('Category name').fill(name);
  await sidebar.getByRole('button', {name:'Create category'}).click();
  await page.getByRole('heading', {name,exact:true}).waitFor();
}
async function device(page, name, excluded) {
  await page.getByRole('link', {name:'Settings', exact:true}).click();
  await page.getByText(`${name} (this device)`, {exact:true}).waitFor();
  assert.equal(await page.getByText(excluded, {exact:false}).count(), 0);
}
async function navigateCategory(page, name) {
  await page.getByRole('link', {name:'Threads', exact:true}).click();
  const sidebar = page.getByRole('complementary', {name:'Workspace navigation'});
  await sidebar.getByRole('link', {name, exact:true}).click();
  await page.getByRole('heading', {name, exact:true}).waitFor();
  return sidebar;
}

async function main() {
  const parallel = process.argv.includes('--parallel-linux');
  if (parallel) {
    assert.equal(process.platform, 'linux');
    execFileSync('bwrap', ['--version']);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rothcold-web-switch-'));
  let ingress, browser, edge, bridge, aProcess, bProcess, observer;
  try {
    const binary = process.env.ROTHCOLD_BROWSER_SERVER || path.join(root, 'server/target/debug/rothcold-agent');
    const certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    execFileSync('openssl', ['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyPath,'-out',certPath], {stdio:'ignore'});
    const cert = await readFile(certPath);
    const spki = createHash('sha256').update(createPublicKey(cert).export({type:'spki',format:'der'})).digest('base64');
    const webPort = await freePort();
    ingress = publicIngress({cert,key:await readFile(keyPath)}, webPort);
    const origin = `https://127.0.0.1:${await listen(ingress.edge)}`;
    const workspace = async (id, excluded = []) => {
      let port;
      do { port = await freePort(); } while (excluded.includes(port));
      const env = {
        ROTHCOLD_DATA_DIR: path.join(dir, `workspace-${id}`),
        ROTHCOLD_NOISE_NATIVE_BIND: '127.0.0.1:0',
        ROTHCOLD_NOISE_WS_BIND: `127.0.0.1:${port}`,
        ROTHCOLD_NOISE_WS_HOST: `127.0.0.1:${port}`,
        ROTHCOLD_NOISE_WS_ORIGIN: origin,
        ROTHCOLD_AGENT_OWNER_TOKEN: token(),
        ROTHCOLD_AGENT_ADAPTER_TOKEN: token(),
      };
      const pin = execFileSync(binary, ['noise-pin'], {env, encoding:'utf8'}).trim();
      assert.match(pin, /^[a-f0-9]{64}$/);
      return {id, port, env, pin};
    };
    const a = await workspace('a', [webPort]);
    const b = await workspace('b', [webPort, a.port]);
    assert.notEqual(a.pin, b.pin);
    assert.notEqual(a.env.ROTHCOLD_AGENT_OWNER_TOKEN, b.env.ROTHCOLD_AGENT_OWNER_TOKEN);
    const start = (fixture) => spawn(binary, [], {env:fixture.env, stdio:['ignore','pipe','inherit']});
    const started = (process, fixture) => ready(process, `browser Noise listening on 127.0.0.1:${fixture.port}`);
    aProcess = start(a);
    const aStartup = await started(aProcess, a);
    if (parallel) {
      const socket = path.join(dir, 'b.sock');
      const { readlink } = require('node:fs/promises');
      bProcess = spawn('bwrap', ['--unshare-net','--die-with-parent','--bind','/','/','--dev','/dev','--proc','/proc',process.execPath,__filename,'--child',binary,socket,await readlink('/proc/self/ns/net')], {
        env:{...b.env, PATH:process.env.PATH, PLAYWRIGHT_DIR:process.env.PLAYWRIGHT_DIR},stdio:['ignore','pipe','inherit'],
      });
      await ready(bProcess, 'Isolated WSS ready');
      bridge = relay({host:'127.0.0.1',port:b.port}, {path:socket});
      await bridge.started;
      const nativeAddress = aStartup.match(/native Noise listening on (127\.0\.0\.1:\d+)/)?.[1];
      assert(nativeAddress);
      const driver = process.env.ROTHCOLD_BROWSER_DRIVER || path.join(root, 'server/target/debug/examples/noise-fixture');
      observer = spawn(driver, [nativeAddress,a.pin], {env:{},stdio:['pipe','pipe','inherit']});
    }
    const config = path.join(dir, 'web.json');
    await writeFile(config, JSON.stringify({defaultBackend:'a',backends:{a:{label:'Workspace A',port:a.port},b:{label:'Workspace B',port:b.port}}}));
    edge = spawn(process.execPath, [path.join(root,'web/server.mjs')], {env:{ROTHCOLD_WEB_CONFIG:config,ROTHCOLD_WEB_PORT:String(webPort),ROTHCOLD_WEB_ORIGIN:origin},stdio:['ignore','pipe','inherit']});
    await ready(edge, origin);
    if (process.env.SHOTS) await mkdir(process.env.SHOTS, {recursive:true});
    browser = await chromium.launch({executablePath:process.env.CHROMIUM, args:[`--ignore-certificate-errors-spki-list=${spki}`]});
    const page = await browser.newPage({viewport:{width:1100,height:800}});
    const wire = [];
    page.on('websocket', (ws) => {
      const frames = [];
      wire.push({url:ws.url(),frames});
      ws.on('framesent', ({payload}) => frames.push(payload));
    });
    await page.goto(origin);
    await choose(page, 'a', a.pin);
    await signIn(page, a.env.ROTHCOLD_AGENT_OWNER_TOKEN, 'Device only for A');
    await category(page, 'Private A category');
    const editor = page.locator('#first-message');
    await editor.fill('Private A unsent draft');
    const aHash = new URL(page.url()).hash;
    let closeOld;
    if (parallel) {
      const lines = createInterface({input:observer.stdout})[Symbol.asyncIterator]();
      async function native(message) {
        observer.stdin.write(`${JSON.stringify(message)}\n`);
        const result = await lines.next();
        assert(!result.done, 'A observer lost its independent socket');
        const reply = JSON.parse(result.value);
        assert.notEqual(reply.type, 'error', reply.message);
        return reply;
      }
      await native({type:'login_native', owner_token:a.env.ROTHCOLD_AGENT_OWNER_TOKEN, name:'A native observer'});
      const sidebar = page.getByRole('complementary', {name:'Workspace navigation'});
      await sidebar.getByText('New category', {exact:true}).click();
      await sidebar.getByLabel('Category name').fill('Committed only on A');
      closeOld = ingress.hold('/noise/a');
      await sidebar.getByRole('button', {name:'Create category'}).click();
      const deadline = Date.now() + 4500;
      while (!(await native({type:'categories',include_archived:true})).page.items.some(({name}) => name === 'Committed only on A')) {
        assert(Date.now() < deadline, 'A mutation must commit before switching with its receipt withheld');
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      assert.equal(new URL(page.url()).hash, aHash, 'receipt is still withheld');
    }
    await toggle(page);
    if (!parallel) {
      await stop(aProcess);
      bProcess = start(b);
      await started(bProcess, b);
    }
    await choose(page, 'b', a.pin);
    await page.getByRole('status').filter({hasText:/Noise pin|secure connection closed/i}).waitFor();
    assert.equal(wire.at(-1).frames.length, 1, 'wrong B pin must not send saved A proof');
    assert.equal(await page.getByLabel('Owner token').count(), 0);
    await choose(page, 'b', b.pin);
    await page.getByLabel('Owner token').waitFor();
    assert.equal(new URL(page.url()).hash, '', 'A selection cleared before entering B');
    await signIn(page, b.env.ROTHCOLD_AGENT_OWNER_TOKEN, 'Device only for B');
    await category(page, 'Private B category');
    assert.equal(await page.getByText('Private A category', {exact:true}).count(), 0);
    assert.equal((await editor.innerText()).trim(), '');
    await device(page, 'Device only for B', 'Device only for A');
    if (process.env.SHOTS) await themeScreens(page, 'switch-workspace-b', [['h1']]);
    await page.reload();
    await page.getByText('Device only for B (this device)', {exact:true}).waitFor();
    closeOld?.();
    assert.equal(await page.getByText('Device only for A', {exact:false}).count(), 0);
    assert.equal(await page.getByText('Committed only on A', {exact:true}).count(), 0);
    await toggle(page);
    if (!parallel) {
      await stop(bProcess);
      aProcess = start(a);
      await started(aProcess, a);
    }
    await choose(page, 'a', a.pin);
    await page.getByRole('link', {name:'Settings',exact:true}).waitFor();
    await device(page, 'Device only for A', 'Device only for B');
    const sidebar = await navigateCategory(page, 'Private A category');
    if (process.env.SHOTS) await themeScreens(page, 'switch-workspace-a', [['h1']]);
    assert.equal(new URL(page.url()).hash, aHash);
    assert.equal(await sidebar.getByRole('link', {name:'Private B category',exact:true}).count(), 0);
    if (parallel) await sidebar.getByRole('link', {name:'Committed only on A',exact:true}).waitFor();
    assert.equal((await editor.innerText()).trim(), '', 'a switch drops the prior backend draft');
    const saved = await page.evaluate(() => new Promise((resolve,reject) => {
      const request = indexedDB.open('rothcold-noise-devices',1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const keys = db.transaction('devices').objectStore('devices').getAll();
        keys.onsuccess = () => { resolve(keys.result.map(({id,privateKey}) => [id,privateKey.extractable])); db.close(); };
      };
    }));
    assert.equal(saved.length, 2);
    assert.notEqual(saved[0][0], saved[1][0]);
    assert(saved.every(([,extractable]) => !extractable));
    console.log(`Chromium WSS two-workspace switch passed (${parallel ? 'simultaneous isolated Linux namespace' : 'serial separate workspaces'}): distinct pins, credentials, directories, and drafts`);
  } finally {
    await browser?.close();
    ingress?.close();
    bridge?.close();
    await Promise.all([stop(observer), stop(aProcess), stop(bProcess), stop(edge)]);
    await rm(dir, {recursive:true,force:true});
  }
}

const run = process.argv.includes('--child') ? namespace : main;
run().catch((error) => { console.error(error); process.exitCode = 1; });
