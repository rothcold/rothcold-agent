const { chromium } = require(process.env.PLAYWRIGHT_DIR);
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { createInterface } = require('node:readline');

async function assertLayout(page, width, height, containers, targets = '') {
  await page.setViewportSize({width,height});
  const problems = await page.evaluate(({containers,targets}) => {
    const failures = [];
    const root = document.documentElement;
    if (root.scrollWidth > innerWidth) failures.push(`document width ${root.scrollWidth}`);
    for (const el of document.querySelectorAll(containers)) {
      if (el.scrollWidth > el.clientWidth + 1) failures.push(`${el.className || el.id} scrolls sideways (${el.scrollWidth}/${el.clientWidth})`);
    }
    if (targets) for (const el of document.querySelectorAll(targets)) {
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      if (r.width < 43.9 || r.height < 43.9) failures.push(`${el.textContent || el.id} target ${r.width}×${r.height}`);
      if (r.left < 0 || r.right > innerWidth + 1) failures.push(`${el.textContent || el.id} leaves the screen`);
    }
    return failures;
  }, {containers,targets});
  assert.deepEqual(problems, [], `${width}×${height} (${containers}): ${problems.join('; ')}`);
}

async function assertGlobalPane(page,label) {
  const path = page.getByRole('navigation',{name:'Breadcrumb'});
  await path.getByText(label,{exact:true}).waitFor();
  assert.equal(await path.innerText(),label);
  assert.equal(await page.locator('#workspace > .sidebar').count(),0);
  const settings = page.locator('.command-bar').getByRole('link',{name:'Settings',exact:true});
  assert.equal(await page.getByRole('link',{name:'Settings',exact:true}).count(),1);
  assert.equal(await settings.getAttribute('aria-current'),label === 'Settings' ? 'page' : null);
  const bounds = await page.locator('#workspace > .pane').evaluate(el => {
    const rail = document.querySelector('#workspace > .workspace-rail').getBoundingClientRect();
    const panel = el.getBoundingClientRect();
    const gear = document.querySelector('.command-settings').getBoundingClientRect();
    return {left:panel.left,right:panel.right,railEnd:rail.right,width:innerWidth,gearEnd:gear.right};
  });
  assert(Math.abs(bounds.left-bounds.railEnd)<=1 && Math.abs(bounds.right-bounds.width)<=1 && bounds.width-bounds.gearEnd<=24,JSON.stringify(bounds));
}

function editorText(editor) {
  return editor.evaluate(el => el.textContent ? el.innerText : '');
}

async function editorPaste(editor, text) {
  await editor.clear();
  await editor.evaluate((el, text) => {
    el.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData}));
  }, text);
}

async function shortDraftGeometry(heading, editor, draft) {
  assert.equal(await editorText(editor), draft);
  const title = await heading.evaluate(el => {
    const r = el.getBoundingClientRect();
    const pane = el.parentElement.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {height:r.height, line:parseFloat(style.lineHeight), overflows:el.scrollWidth > el.clientWidth,
      ellipsis:style.textOverflow === 'ellipsis', fits:r.top >= pane.top && r.bottom <= pane.bottom};
  });
  assert(title.fits && title.overflows && title.ellipsis && Math.abs(title.height - title.line) < 1, JSON.stringify(title));
  const result = await editor.evaluate(el => {
    const form = el.closest('form');
    const style = getComputedStyle(form);
    const field = getComputedStyle(el);
    const available = form.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const lineHeight = parseFloat(field.lineHeight);
    const lineRoom = el.clientHeight - parseFloat(field.paddingTop) - parseFloat(field.paddingBottom);
    const send = form.querySelector('button.primary-action').getBoundingClientRect();
    const timeline = document.querySelector('#turns').getBoundingClientRect();
    return {width:el.clientWidth,height:el.clientHeight,available,lineHeight,lineRoom,font:parseFloat(field.fontSize),
      draftFits:el.scrollHeight <= el.clientHeight,sendBottom:send.bottom,screenHeight:innerHeight,timeline:timeline.height};
  });
  assert(Math.abs(result.width - result.available) <= 1 && result.lineRoom >= 2 * result.lineHeight && result.draftFits, JSON.stringify(result));
  assert(result.sendBottom <= result.screenHeight && result.timeline >= 72, JSON.stringify(result));
  return result;
}

async function profilesAttachmentsAndMoves(page, origin) {
  const newThread = page.locator('#create');
  const reply = page.locator('#compose');
  const data = process.env.FEATURE_DATA;
  const image = path.join(data, 'sample.png');
  const wave = path.join(data, 'sample.wav');
  const video = path.join(__dirname, 'fixtures', 'video.webm');
  const markup = Buffer.from('<!doctype html><h1>Download only</h1>');
  const tray = page.getByRole('list', {name:'Pending attachments'});
  const sent = page.getByRole('list', {name:'Message attachments'});
  const stages = createInterface({input:process.stdin})[Symbol.asyncIterator]();
  async function checkpoint(out, expected) {
    process.stdout.write(`${out}\n`);
    assert.equal((await stages.next()).value, expected);
  }
  async function shot(name, containers, mobileHeight = 800) {
    for (const width of [1100, 375]) {
      await assertLayout(page, width, width === 375 ? mobileHeight : 800, containers);
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS, `${name}-${width}.png`)});
    }
    await page.setViewportSize({width:1100, height:800});
  }
  async function ready(locator) {
    await locator.locator('img').waitFor();
    await locator.locator('video').waitFor();
    await locator.locator('audio').waitFor();
    await page.waitForFunction(selector => {
      const parent = document.querySelector(selector);
      return parent?.querySelector('img')?.naturalWidth > 0 && parent?.querySelector('video')?.videoWidth > 0 &&
        parent?.querySelector('audio')?.duration > 0;
    }, await locator.getAttribute('class').then(name => '.' + name.split(' ').at(-1)));
    assert.deepEqual(await locator.locator('.attachment-badge').allTextContents(), ['Image', 'Video', 'Audio', 'File']);
  }
  await newThread.getByRole('button', {name:'Attach files'}).waitFor();
  await newThread.locator('input[type=file]').setInputFiles([image, video, wave]);
  await tray.getByText('Audio', {exact:true}).waitFor();
  await newThread.locator('input[type=file]').setInputFiles({name:'memo.html', mimeType:'text/html', buffer:markup});
  await tray.getByText('File', {exact:true}).waitFor();
  await ready(tray);
  assert((await tray.locator('img').getAttribute('src')).startsWith('blob:'));
  await shot('profile-attachments-composer', '.pane-scroll, #create, .pending-attachments');
  await newThread.getByRole('button', {name:'Start thread'}).click();
  await page.getByRole('heading', {name:'sample.png', exact:true}).waitFor();
  await ready(sent);
  await page.getByText('Queued. Waiting to send to Hermes.', {exact:true}).waitFor();
  assert.equal(await page.locator('.user-turn .speaker').innerText(), 'You');
  const thread = page.url();

  const img = sent.locator('img');
  const media = await img.getAttribute('src');
  assert.match(media, /^\/api\/media\/[a-f0-9]{64}\/attachments\/[a-f0-9-]{36}$/);
  const range = await page.request.get(origin + media, {headers:{Range:'bytes=1-3'}});
  assert.equal(range.status(), 206);
  assert.equal((await range.body()).toString(), 'PNG');
  assert.match(range.headers()['content-range'], /^bytes 1-3\/\d+$/);
  const invalid = media.replace(/\/media\/[a-f0-9]{64}/, '/media/' + '0'.repeat(64));
  assert.equal((await page.request.get(origin + invalid)).status(), 404);
  const anonymous = await page.context().browser().newContext();
  try { assert.equal((await anonymous.request.get(origin + media)).status(), 401); }
  finally { await anonymous.close(); }
  await sent.getByRole('button', {name:'Preview sample.png'}).click();
  const dialog = page.getByRole('dialog', {name:'sample.png'});
  await dialog.waitFor();
  await shot('profile-attachments-lightbox', '.image-dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  const downloaded = page.waitForEvent('download');
  await sent.getByRole('link', {name:'Download memo.html'}).click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'memo.html');
  assert.deepEqual(await readFile(await download.path()), markup);
  const audio = sent.locator('audio');
  assert(await audio.evaluate(async el => { el.muted = true; await el.play(); const ok = !el.paused; el.pause(); return ok; }));

  await reply.getByRole('textbox').fill('Draft follows the thread');
  await reply.locator('input[type=file]').setInputFiles([image, wave]);
  await tray.getByText('Audio', {exact:true}).waitFor();
  await tray.getByRole('button', {name:'Remove sample.wav'}).click();
  await tray.getByRole('button', {name:'Remove sample.wav'}).waitFor({state:'detached'});
  const move = page.getByRole('button', {name:'Move thread'});
  await move.click();
  const destination = page.getByLabel('Move to category');
  await destination.waitFor();
  assert(await page.getByRole('button', {name:'Move', exact:true}).isDisabled());
  await destination.press('Escape');
  await destination.waitFor({state:'detached'});
  assert(await move.evaluate(el => el === document.activeElement));
  await move.click();
  await destination.selectOption(process.env.MOVE_OFFLINE);
  await shot('thread-move-offline', '.pane-head, #turns, #compose');
  await page.getByRole('button', {name:'Move', exact:true}).click();
  await page.getByRole('link', {name:'Back to Research'}).waitFor();
  assert.equal(page.url(), thread);
  const crumb = page.getByRole('navigation',{name:'Breadcrumb'});
  assert.deepEqual(await crumb.locator(':scope > *').allTextContents(),['Research','→','sample.png']);
  assert.equal(await editorText(reply.getByRole('textbox')), 'Draft follows the thread');
  await tray.getByText('sample.png', {exact:true}).waitFor();
  await tray.getByRole('button', {name:'Remove sample.png'}).click();
  await checkpoint('offline-moved', 'online');
  await page.getByText('The attachments reached the gateway.', {exact:true}).waitFor();
  await page.getByRole('link', {name:'Settings',exact:true}).click();
  const owner = page.getByLabel('Owner name', {exact:true});
  const agent = page.getByLabel('Agent name', {exact:true});
  const ownerPicker = page.locator('.profile-identity').first().locator('input[type=file]:enabled');
  const agentPicker = page.locator('.profile-identity').last().locator('input[type=file]:enabled');
  await owner.fill('Mara');
  await page.getByRole('button', {name:'Save Owner name'}).click();
  await ownerPicker.setInputFiles(image);
  await page.getByRole('button', {name:'Remove Owner avatar'}).waitFor();
  await page.getByRole('button', {name:'Remove Owner avatar'}).click();
  await page.getByRole('button', {name:'Remove Owner avatar'}).waitFor({state:'detached'});
  await ownerPicker.setInputFiles(image);
  await page.getByRole('button', {name:'Remove Owner avatar'}).waitFor();
  await agent.fill('Custom agent');
  await page.getByRole('button', {name:'Save Agent name'}).click();
  const agentAvatar = page.locator('.profile-identity').last().locator('.avatar img');
  const passive = await agentAvatar.getAttribute('src');
  await agentPicker.setInputFiles(image);
  await page.waitForFunction(old => {
    const avatar = document.querySelector('.profile-identity:last-of-type .avatar img');
    return !!avatar?.naturalWidth && avatar.getAttribute('src') !== old;
  }, passive);
  await page.getByLabel('Backend profile').selectOption('hermes');
  await checkpoint('refresh-profile', 'profile-ready');
  await page.getByRole('button', {name:'Sync from backend'}).click();
  await page.getByText('Updated from the backend.', {exact:true}).waitFor();
  assert.equal(await agent.inputValue(), 'Refreshed Workspace Hermes');
  assert.equal(await owner.inputValue(), 'Mara');
  await shot('settings-profile', '.pane-scroll, .settings-profile');
  const sourceCategory = origin + '/#channel/' + process.env.MOVE_OFFLINE;
  const threadHash = new URL(thread).hash;
  const categoryRow = page.locator(`.category-threads a[href="${threadHash}"]`);
  const categoryFeed = page.locator('.pane-scroll[data-category]');
  await page.goto(sourceCategory);
  await categoryRow.waitFor();
  const sourceScroll = await categoryFeed.evaluate(el => { el.scrollTop = 24; return el.scrollTop; });
  assert(sourceScroll > 0);
  await categoryRow.click();
  await page.getByText('Refreshed Workspace Hermes', {exact:true}).waitFor();
  await page.getByText('Mara', {exact:true}).waitFor();
  await page.locator('.user-turn .avatar img').waitFor();
  await page.locator('.assistant-turn .avatar img').first().waitFor();
  await page.getByText('Activity (1 update)', {exact:true}).click();
  await page.getByText('Refreshed Workspace Hermes · update', {exact:true}).waitFor();
  await page.locator('.interim-label .avatar img').waitFor();
  await page.locator('#turns').evaluate(el => { el.scrollTop = 0; });
  await shot('profile-attachments-timeline', '#turns, .sent-attachments', 970);
  assert.equal(await editorText(reply.getByRole('textbox')), 'Draft follows the thread');
  await move.click();
  await destination.selectOption(process.env.MOVE_ONLINE);
  await shot('thread-move-online', '.pane-head, #turns, #compose');
  await page.getByRole('button', {name:'Move', exact:true}).click();
  await page.getByRole('link', {name:'Back to Archive'}).waitFor();
  assert.equal(page.url(), thread);
  await page.goBack();
  const sourceHeading = page.getByRole('heading', {name:'Research', exact:true});
  await sourceHeading.waitFor();
  assert.equal(page.url(), sourceCategory);
  assert.equal(await categoryFeed.evaluate(el => el.scrollTop), sourceScroll);
  assert(await sourceHeading.evaluate(el => el === document.activeElement));
  assert.equal(await categoryRow.count(), 0);
  await page.goForward();
  await page.getByRole('link', {name:'Back to Archive'}).waitFor();
  await page.locator('.workspace-rail a[href="#inbox"]').first().click();
  await page.locator('.inbox-pane .items a[href="' + new URL(thread).hash + '"]').getByText(/Archive/).waitFor();
  await page.goto(origin + '/#channel/' + process.env.MOVE_ONLINE);
  await page.locator('.category-threads a[href="' + new URL(thread).hash + '"]').waitFor();
  await page.locator('.category-threads a[href="' + new URL(thread).hash + '"]').click();
  await reply.getByRole('textbox').fill('');
  await reply.locator('input[type=file]').setInputFiles(wave);
  await tray.getByText('Audio', {exact:true}).waitFor();
  await reply.getByRole('textbox').press('Enter');
  await page.locator('.turn').nth(1).getByText('sample.wav', {exact:true}).waitFor();
  await page.getByText('The attachments reached the gateway.', {exact:true}).nth(1).waitFor();
  assert.equal(await page.locator('.turn').last().locator('.push-tag').count(), 0);

  // Commit the next reply but hold the POST receipt until after another composer mounts.
  const replyEndpoint = `${origin}/api/chats/${threadHash.slice(1)}/turns`;
  const attempts = [];
  let arrived, release;
  const committed = new Promise(resolve => { arrived = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const holdReply = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const input = route.request().postDataJSON();
    const response = await route.fetch();
    attempts.push({ input, status: response.status() });
    if (attempts.length === 1) { arrived(); await held; }
    await route.fulfill({response});
  };
  await page.route(replyEndpoint, holdReply);
  try {
    await editorPaste(reply.getByRole('textbox'), 'Hold this **attachment** reply');
    await reply.locator('input[type=file]').setInputFiles(wave);
    await tray.getByText('Audio', {exact:true}).waitFor();
    await reply.getByRole('button', {name:'Send message'}).click();
    await committed;
    assert.equal(attempts[0].status, 202);
    assert.equal(attempts[0].input.text, 'Hold this **attachment** reply');
    assert.equal(await reply.getByRole('textbox').getAttribute('contenteditable'), 'false');
    assert.equal(await reply.getByRole('textbox').getAttribute('aria-disabled'), 'true');
    await page.getByRole('link', {name:'Back to Archive'}).click();
    await categoryRow.click();
    await reply.getByRole('textbox').waitFor();
    assert.equal(await editorText(reply.getByRole('textbox')), 'Hold this attachment reply');
    await tray.getByText('Audio', {exact:true}).waitFor();
    const received = page.waitForResponse(res => res.url() === replyEndpoint && res.request().method() === 'POST');
    release();
    await (await received).finished();
    // Let React process any state updates the receipt scheduled before the retry.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await editorText(reply.getByRole('textbox')), 'Hold this attachment reply');
    await tray.getByText('Audio', {exact:true}).waitFor({timeout:3000});
    await page.getByRole('link', {name:'Settings'}).click();
    await page.getByRole('button', {name:'Change server'}).click();
    await page.getByRole('button', {name:'Cancel', exact:true}).click();
    await page.getByRole('link',{name:'Threads',exact:true}).click();
    await page.locator('#workspace > .sidebar').locator(`a[href="${threadHash}"]`).click();
    assert.equal(await reply.getByRole('textbox').locator('strong').innerText(), 'attachment');
    await tray.getByText('Audio', {exact:true}).waitFor();
    const replay = page.waitForResponse(res => res.url() === replyEndpoint && res.request().method() === 'POST');
    await reply.getByRole('button', {name:'Send message'}).click();
    assert.equal((await replay).status(), 200);
    assert.deepEqual(attempts, [{input:attempts[0].input,status:202}, {input:attempts[0].input,status:200}]);
    assert.equal(attempts[0].input.attachments.length, 1);
    await tray.waitFor({state:'detached'});
    assert.equal(await editorText(reply.getByRole('textbox')), '');
    const rows = await page.evaluate(async url => (await fetch(url, {
      headers:{'X-Rothcold-Server':'http://127.0.0.1:8766'},
    })).json(), replyEndpoint);
    assert.equal(rows.filter(row => row.text === attempts[0].input.text).length, 1);
    assert.equal(rows.find(row => row.id === attempts[0].input.id).attachments[0].id, attempts[0].input.attachments[0]);
  } finally {
    release();
    await page.unroute(replyEndpoint, holdReply);
  }
}

(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM, args:[
    '--disable-background-networking','--disable-component-update','--no-first-run',
    '--proxy-server=http://127.0.0.1:1','--proxy-bypass-list=127.0.0.1',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
  ]});
  try {
    if (process.argv.includes('--tls')) {
      // This context trusts only Chromium's usual roots and the disposable NSS CA; no bypass flags.
      const ctx = await browser.newContext({serviceWorkers:'block'});
      const page = await ctx.newPage();
      await page.goto(process.env.TLS_WEB_ORIGIN);
      assert(await page.evaluate(() => window.isSecureContext));
      await page.getByRole('button',{name:'Connect',exact:true}).click();
      await page.getByLabel('Owner token').fill(process.env.ROTHCOLD_AGENT_OWNER_TOKEN);
      await page.getByRole('button',{name:'Open workspace'}).click();
      await page.getByRole('heading',{name:'General'}).waitFor();
      const [cookie] = await ctx.cookies();
      assert(cookie?.name.startsWith('__Host-rothcold_'));
      assert(cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/');
      assert.equal(await page.evaluate(() => document.cookie), '');
      await page.reload();
      await page.getByRole('heading',{name:'General'}).waitFor();
      return;
    }
    const origin = 'http://127.0.0.1:8765';
    const apiOrigin = 'http://127.0.0.1:8766';
    const outsideOrigins = []; const errors = [];
    async function open(url, width) {
      const ctx = await browser.newContext({viewport:{width,height:800}, serviceWorkers:'block'});
      await ctx.route('**/*', route => {
        const target = new URL(route.request().url()).origin;
        if (target === origin) return route.continue();
        outsideOrigins.push(target);
        return route.abort();
      });
      await ctx.grantPermissions(['notifications'],{origin});
      await ctx.addInitScript(() => {
        window.sentAlerts = [];
        window.Notification = new Proxy(Notification, {construct(target,args) {
          const notice = new target(...args);
          window.sentAlerts.push(notice);
          return notice;
        }});
      });
      const page = await ctx.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (/content.security.policy|\bCSP\b/i.test(message.text())) errors.push(message.text());
      });
      await page.goto(url);
      assert.equal(await page.title(), 'rothcold-agent');
      await page.getByRole('heading',{name:'Connect to a server'}).waitFor();
      assert.equal(await page.getByLabel('Server address').inputValue(),apiOrigin);
      for (const size of [1100,375]) {
        await assertLayout(page,size,800,'#gate','#gate input, #gate button');
        if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,`connection-${size}.png`)});
      }
      await assertLayout(page,320,420,'#gate','#gate input, #gate button');
      await page.getByRole('button',{name:'Connect',exact:true}).click();
      await page.getByLabel('Owner token').waitFor();
      await assertLayout(page,320,420,'#gate','#gate input, #gate button');
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,'login-320.png')});
      await page.setViewportSize({width,height:800});
      await page.getByLabel('Owner token').fill(process.env.ROTHCOLD_AGENT_OWNER_TOKEN);
      await page.getByLabel('Device name (optional)').fill('Desktop fixture');
      await page.getByRole('button',{name:'Open workspace'}).click();
      return page;
    }
    const page = await open(origin,1100);
    await page.getByRole('heading',{name:'General'}).waitFor();
    if (process.argv.includes('--features')) {
      await profilesAttachmentsAndMoves(page, origin);
      assert.deepEqual(outsideOrigins, []);
      assert.deepEqual(errors, []);
      return;
    }
    if (process.argv.includes('--offline')) {
      const nativeLogin = await fetch(apiOrigin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:process.env.ROTHCOLD_AGENT_OWNER_TOKEN,name:'Lost phone'})});
      assert.equal(nativeLogin.status,200);
      const lost = (await nativeLogin.json()).session;
      const cookie = (await page.context().cookies()).find(entry => entry.name.startsWith('rothcold_'));
      assert(cookie?.httpOnly && cookie.sameSite === 'Strict' && cookie.expires > Date.now()/1000);
      assert.equal(await page.evaluate(() => document.cookie), '');
      await page.getByRole('link',{name:'Settings'}).click();
      await page.getByRole('heading',{name:'Settings'}).waitFor();
      const revoke = page.getByRole('button',{name:'Revoke Lost phone'});
      await revoke.click();
      await revoke.waitFor({state:'detached'});
      assert.equal((await fetch(apiOrigin+'/api/me',{headers:{Authorization:'Bearer '+lost}})).status,401);
      async function settings() {
        const link = page.locator('.command-bar').getByRole('link',{name:'Settings',exact:true});
        const contrast = await link.evaluate(el => {
          const bar = el.closest('.command-bar');
          const luminance = value => value.match(/\d+/g).slice(0,3).map(Number).reduce((sum, channel, i) => {
            const s = channel / 255;
            return sum + [0.2126, 0.7152, 0.0722][i] * (s <= 0.04045 ? s / 12.92 : ((s+0.055)/1.055)**2.4);
          },0);
          const fg = luminance(getComputedStyle(el).color);
          const bg = luminance(getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(bar).backgroundColor : getComputedStyle(el).backgroundColor);
          return (Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05);
        });
        assert(contrast >= 4.5, String(contrast));
        await link.click();
        await page.getByRole('heading',{name:'Settings'}).waitFor();
      }
      await assertGlobalPane(page,'Settings');
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,'settings-1100.png')});
      await page.setViewportSize({width:375,height:800});
      await settings();
      await assertGlobalPane(page,'Settings');
      await assertLayout(page,320,420,'.pane-scroll','.settings-actions button');
      await page.getByRole('button',{name:'Workspace',exact:true}).click();
      await assertLayout(page,320,420,'.sidebar','.sidebar a, .sidebar button, .sidebar summary');
      await page.keyboard.press('Escape');
      await page.setViewportSize({width:375,height:800});
      if (process.env.SHOTS) {
        await page.screenshot({path:path.join(process.env.SHOTS,'settings-375.png')});
        await page.getByRole('button',{name:'Workspace',exact:true}).click();
        await page.screenshot({path:path.join(process.env.SHOTS,'settings-nav-375.png')});
        await page.keyboard.press('Escape');
      }
      await page.setViewportSize({width:1100,height:800});
      await page.reload();
      await page.getByRole('heading',{name:'Settings'}).waitFor();
      await page.getByRole('link',{name:'Threads',exact:true}).click();
      const offlineReply = '**bold** and `code`';
      for (const [text, selector] of [['First offline message', '#create'], [offlineReply, '#compose']]) {
        const form = page.locator(selector);
        const submitLabel = selector === '#create' ? 'Start thread' : 'Send message';
        const buttonBox = await form.locator('button.primary-action').boundingBox();
        assert(buttonBox && buttonBox.height <= 30 && buttonBox.width <= 40, JSON.stringify(buttonBox));
        for (const [label, btn] of [
          ['Attach files', form.getByRole('button', { name: 'Attach files' })],
          ['Hide formatting', form.getByRole('button', { name: 'Hide formatting' })],
          [submitLabel, form.getByRole('button', { name: submitLabel })],
        ]) {
          assert.equal((await btn.textContent()).trim(), '', `${label} must be icon-only`);
          assert.equal(await btn.getAttribute('data-tip'), label);
        }
        const toolbar = form.getByRole('toolbar', { name: 'Formatting' });
        await toolbar.waitFor();
        const boldButton = toolbar.getByRole('button', { name: 'Bold' });
        const boldBox = await boldButton.boundingBox();
        assert(boldBox && boldBox.height <= 28 && boldBox.width <= 28, JSON.stringify(boldBox));
        await form.getByRole('button', { name: submitLabel }).hover();
        assert.equal(
          await form.getByRole('button', { name: submitLabel }).evaluate((el) => getComputedStyle(el, '::after').opacity),
          '1',
        );
        await form.getByRole('button', { name: 'Hide formatting' }).click();
        assert.equal(await toolbar.count(), 0);
        await form.getByRole('button', { name: 'Show formatting' }).click();
        await toolbar.waitFor();
        const box = form.getByRole('textbox');
        // Verify single-line default height, growth on newline, and 60% pane height cap.
        const oneLine = await box.evaluate((el) => {
          const s = getComputedStyle(el);
          return { h: el.getBoundingClientRect().height, lh: parseFloat(s.lineHeight), pad: parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) };
        });
        assert(Math.abs(oneLine.h - (oneLine.lh + oneLine.pad)) <= 2, JSON.stringify(oneLine));
        await box.click();
        await boldButton.click();
        assert.equal(await boldButton.getAttribute('aria-pressed'), 'true');
        await page.keyboard.type('hi');
        assert.equal(await box.locator('strong').innerText(), 'hi');
        await boldButton.click();
        assert.equal(await box.getAttribute('aria-multiline'), 'true');
        assert.equal(await page.locator('style').count(), 0, 'the editor must not inject runtime styles');
        await box.fill('ab');
        await box.evaluate(el => window.getSelection().collapse(el.querySelector('p').firstChild, 1));
        await page.keyboard.press('Control+Enter');
        const twoLine = await box.evaluate((el) => el.getBoundingClientRect().height);
        assert(twoLine >= oneLine.h + oneLine.lh * 0.8, `Expected growth to 2 lines: ${oneLine.h} -> ${twoLine}`);
        await page.keyboard.type('c');
        assert.equal(await editorText(box), 'a\ncb');
        if (selector === '#compose') {
          await editorPaste(box, Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'));
          const capped = await box.evaluate((el) => {
            const formRect = el.closest('form').getBoundingClientRect();
            const paneRect = el.closest('.conversation').getBoundingClientRect();
            return { formH: formRect.height, paneH: paneRect.height, scrolls: el.scrollHeight > el.clientHeight };
          });
          assert(capped.formH <= capped.paneH * 0.6 + 1 && capped.formH > oneLine.h * 3 && capped.scrolls, JSON.stringify(capped));
          await box.fill('ab');
          await box.evaluate(el => window.getSelection().collapse(el.querySelector('p').firstChild, 1));
          await page.keyboard.press('Control+Enter');
          await page.keyboard.type('c');
        }
        await box.press('Shift+Enter');
        await page.keyboard.type('d');
        assert.equal(await editorText(box), 'a\nc\ndb');
        await box.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
        assert.equal(await editorText(box), 'a\nc\ndb');
        assert.equal(await box.getAttribute('contenteditable'), 'true');
        const endpoint = selector === '#create' ? /\/api\/chats$/ : /\/api\/chats\/[^/]+\/turns$/;
        async function assertComposerPost(expected) {
          const probe = route => route.request().method() === 'POST'
            ? route.fulfill({status:400, body:'Composer payload probe'}) : route.continue();
          await page.route(endpoint, probe);
          try {
            const posted = page.waitForRequest(request => request.method() === 'POST' && endpoint.test(request.url()));
            await form.locator('button.primary-action').click();
            assert.equal((await posted).postDataJSON().text, expected);
            await page.getByRole('status').getByText('Composer payload probe').waitFor();
            await form.locator('[contenteditable=true]').waitFor();
          } finally {
            await page.unroute(endpoint, probe);
          }
        }
        await assertComposerPost('a  \nc  \ndb');
        if (selector === '#compose') {
          async function reopenReplyDraft() {
            await page.getByRole('link', {name:'Back to General'}).click();
            await page.locator('.category-threads').getByRole('link', {name:'First offline message'}).click();
            await form.locator('[contenteditable=true]').waitFor();
          }
          for (const plain of ['alpha\nbeta', 'alpha\n\n\nbeta']) {
            await editorPaste(box, plain);
            assert.equal(await editorText(box), plain);
            await assertComposerPost(plain);
            await reopenReplyDraft();
            assert.equal(await editorText(box), plain);
            await assertComposerPost(plain);
          }
          const unsupported = '**Heading**\n\n| alpha | beta |\n| --- | --- |\n| one | two |\n\n<section>Hidden otherwise</section>';
          await editorPaste(box, unsupported);
          assert.equal(await editorText(box), unsupported);
          assert.equal(await box.locator('strong, table, section').count(), 0);
          const literal = '\\*\\*Heading\\*\\*\n\n| alpha | beta |\n| --- | --- |\n| one | two |\n\n&lt;section&gt;Hidden otherwise&lt;/section&gt;';
          await assertComposerPost(literal);
          await reopenReplyDraft();
          assert.equal(await editorText(box), unsupported);
          await assertComposerPost(literal);
          for (const indent of [' ', '  ', '   ']) {
            const indentedFence = `**keep**\n\n${indent}\`\`\`text\n${indent}keep this body\n${indent}\`\`\``;
            await editorPaste(box, indentedFence);
            assert.equal(await editorText(box), indentedFence);
            assert.equal(await box.locator('strong, pre').count(), 0);
          }
          const singleLine = '# Draft <em>example</em>';
          await editorPaste(box, singleLine);
          assert.equal(await editorText(box), singleLine);
          await reopenReplyDraft();
          assert.equal(await editorText(box), singleLine);
          assert.equal(await box.locator('h1, em').count(), 0);
          await assertComposerPost('# Draft &lt;em&gt;example&lt;/em&gt;');
          const codeBody = 'alpha\n```\nbeta';
          await editorPaste(box, '~~~text\n' + codeBody + '\n~~~');
          assert.equal(await box.locator('pre code').innerText(), codeBody);
          const fenced = '````text\n' + codeBody + '\n````\n\n';
          await assertComposerPost(fenced);
          await reopenReplyDraft();
          assert.equal(await box.locator('pre code').innerText(), codeBody);
          await assertComposerPost(fenced);
          const codeWithTildes = 'alpha\n~~~~\nbeta';
          const tildeFence = '~~~~~lang`extra\n' + codeWithTildes + '\n~~~~~';
          await editorPaste(box, tildeFence);
          const code = box.locator('pre code');
          assert.equal(await code.innerText(), codeWithTildes);
          assert.equal(await code.getAttribute('class'), 'language-lang`extra');
          await assertComposerPost(tildeFence + '\n\n');
          await reopenReplyDraft();
          assert.equal(await code.innerText(), codeWithTildes);
          assert.equal(await code.getAttribute('class'), 'language-lang`extra');
          await assertComposerPost(tildeFence + '\n\n');
          const leadingTildeFence = '~~~ ~lang`extra\nalpha\n~~~';
          await editorPaste(box, leadingTildeFence);
          assert.equal(await code.innerText(), 'alpha');
          assert.equal(await code.getAttribute('class'), 'language-~lang`extra');
          await assertComposerPost(leadingTildeFence + '\n\n');
          await reopenReplyDraft();
          assert.equal(await code.innerText(), 'alpha');
          assert.equal(await code.getAttribute('class'), 'language-~lang`extra');
          await assertComposerPost(leadingTildeFence + '\n\n');
          await box.clear();
          await box.pressSequentially('abc');
          await box.press('Control+Enter');
          const trailingBreak = box.locator('p > br:not(.ProseMirror-trailingBreak)');
          assert.equal(await trailingBreak.count(), 1);
          await reopenReplyDraft();
          assert.equal(await trailingBreak.count(), 1);
          await assertComposerPost('abc  \n');
          await box.clear();
          await box.pressSequentially('> abc');
          await box.press('Control+Enter');
          const quoteBreak = box.locator('blockquote p > br:not(.ProseMirror-trailingBreak)');
          assert.equal(await quoteBreak.count(), 1);
          await reopenReplyDraft();
          assert.equal(await quoteBreak.count(), 1);
          assert.equal(await box.locator('blockquote p').textContent(), 'abc');
          await assertComposerPost('> abc  \n>\n\n');
          await editorPaste(box, 'A **Markdown** paste and `code`.');
          assert.equal(await box.locator('strong').innerText(), 'Markdown');
          assert.equal(await box.locator('code').innerText(), 'code');
          await editorPaste(box, 'literal_name and /sethome');
          assert.equal(await editorText(box), 'literal_name and /sethome');
          await editorPaste(box, '/approve session');
          assert.equal(await editorText(box), '/approve session');
          for (const [input, rendered] of [['# Heading', 'h1'], ['- item', 'ul li'], ['1. item', 'ol li'], ['> quote', 'blockquote'], ['~~strike~~', 's'], ['*italic*', 'em'], ['``` ', 'pre']]) {
            await box.clear();
            await page.keyboard.type(input);
            await box.locator(rendered).waitFor();
          }
          await page.keyboard.type('ab');
          await box.press('ArrowLeft');
          await box.press('Control+Enter');
          await page.keyboard.type('c');
          assert.equal(await box.locator('pre').innerText(), 'a\ncb');
          await editorPaste(box, 'a'.repeat(8001));
          assert.equal((await editorText(box)).length, 8001);
          const limit = form.getByRole('alert');
          await limit.waitFor();
          assert.match(await limit.textContent(), /8,000 characters/);
          assert.equal(await box.getAttribute('aria-invalid'), 'true');
          await form.getByRole('button', {name:'Send message'}).click();
          assert.equal(await page.locator('article').count(), 1);
          await box.clear();
          await page.keyboard.type(text);
          assert.equal(await box.locator('strong').innerText(), 'bold');
          assert.equal(await box.locator('code').innerText(), 'code');
        } else {
          await box.fill(text);
        }
        const sent = page.waitForRequest(request => request.method() === 'POST' && /\/api\/chats(?:\/[^/]+\/turns)?$/.test(request.url()));
        await box.press('Enter');
        assert.equal((await sent).postDataJSON().text, text);
        await page.locator('article').getByText(text,{exact:true}).waitFor();
      }
      assert.equal(await page.getByText('Queued. Waiting to send to Hermes.',{exact:true}).count(),2);
      for (const width of [1100,375]) {
        await page.setViewportSize({width,height:800});
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,`queued-${width}.png`),fullPage:true});
      }
      const first = page.url();
      await page.getByLabel('Your message').fill('Unsent reply');
      await page.setViewportSize({width:1100,height:800});
      async function changeServer() {
        await settings();
        await page.getByRole('button',{name:'Change server'}).click();
      }
      const address = page.getByLabel('Server address');
      const connect = page.getByRole('button',{name:'Connect',exact:true});
      const cancel = page.getByRole('button',{name:'Cancel',exact:true});
      const original = page.getByRole('navigation',{name:'Categories'}).getByRole('link',{name:'First offline message'});
      const reply = page.getByLabel('Your message');
      await changeServer();
      await cancel.click();
      await page.getByRole('link',{name:'Threads',exact:true}).click();
      await original.click();
      assert.equal(await editorText(reply),'Unsent reply');
      await changeServer();
      await address.fill('http://127.0.0.1:9999');
      await connect.click();
      await page.getByRole('status').getByText('This server is not configured on this web host.').waitFor();
      assert.equal(await page.getByLabel('Owner token').count(),0);
      await cancel.click();
      await page.getByRole('link',{name:'Threads',exact:true}).click();
      await original.click();
      assert.equal(await editorText(reply),'Unsent reply');

      // Keep an A notification and a successful A write response across the switch.
      await page.getByRole('link',{name:/Notifications/}).click();
      await page.getByRole('button',{name:'Enable browser alerts'}).click();
      await page.getByRole('button',{name:'Turn off browser alerts'}).waitFor();
      const pushed = await fetch(apiOrigin+'/adapter/push',{method:'POST',headers:{Origin:apiOrigin,Authorization:'Bearer '+process.env.ROTHCOLD_AGENT_ADAPTER_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),chat:new URL(first).hash.slice(1),text:'A notification before switching.'})});
      assert.equal(pushed.status,200);
      await page.waitForFunction(() => window.sentAlerts.length === 1);
      await page.evaluate(() => { window.oldNoticeClick = window.sentAlerts[0].onclick; });
      let releaseCategory, categoryWritten, categoryId;
      const holdCategory = new Promise(resolve => { releaseCategory = resolve; });
      const written = new Promise(resolve => { categoryWritten = resolve; });
      await page.getByRole('link',{name:'Threads',exact:true}).click();
      await page.route('**/api/channels', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        assert.equal(response.status(),201);
        categoryId = (await response.json()).id;
        categoryWritten();
        await holdCategory;
        await route.fulfill({response});
      });
      await page.getByText('New category',{exact:true}).click();
      await page.getByLabel('Category name').fill('Late A category');
      await page.getByRole('button',{name:'Create category'}).click();
      await written;
      await changeServer();
      const alternate = 'http://127.0.0.1:8770';
      await address.fill(alternate);
      await connect.click();
      await page.getByRole('heading',{name:'Sign in'}).waitFor();
      const owner = page.getByLabel('Owner token');
      assert.equal(await owner.inputValue(),'');
      await owner.fill(process.env.ALTERNATE_OWNER_TOKEN);
      await page.getByLabel('Device name (optional)').fill('Server B browser');
      await page.getByRole('button',{name:'Open workspace'}).click();
      await page.getByRole('heading',{name:'General'}).waitFor();
      assert.equal(await original.count(),0);
      assert.equal(await editorText(page.getByLabel('New thread in General')),'');
      const response = page.waitForResponse(r => r.url().endsWith('/api/channels') && r.request().method() === 'POST');
      releaseCategory();
      await (await response).finished();
      assert.equal(await page.evaluate(() => location.hash),'', 'late A category must not navigate B');
      await page.evaluate(() => window.oldNoticeClick());
      assert.equal(await page.evaluate(() => location.hash),'', 'old A notification must not navigate B');
      await page.getByRole('heading',{name:'General'}).waitFor();
      assert.equal(await page.getByText('Late A category',{exact:true}).count(),0);
      await page.unroute('**/api/channels');
      // Give both stores the same thread ID so a mistakenly shared draft map would leak text.
      const sharedId = new URL(first).hash.slice(1);
      assert.equal(await page.evaluate(async ({id, target}) => (await fetch('/api/chats', {
        method:'POST', headers:{'Content-Type':'application/json','X-Rothcold-Server':target},
        body:JSON.stringify({id,text:'Only on server B'}),
      })).status, {id:sharedId,target:alternate}),202);
      const backendCookies = (await page.context().cookies()).filter(entry => entry.name.startsWith('rothcold_'));
      assert.equal(backendCookies.length,2);
      assert.equal(new Set(backendCookies.map(entry => entry.value)).size,2);
      async function selectServer(server) {
        await changeServer();
        await address.fill(server);
        await connect.click();
        await page.getByRole('heading',{name:'General'}).waitFor();
      }
      // Verify draft isolation before reloading so reload cannot mask a leak.
      await changeServer();
      await connect.click(); // Reopen B to refresh the thread list after the fixture write.
      await page.getByRole('link',{name:'Threads',exact:true}).click();
      await page.getByRole('navigation').getByRole('link',{name:'Only on server B'}).click();
      assert.equal(await editorText(reply),'');
      await reply.fill('Unsent only on B');
      await selectServer(apiOrigin);
      assert.equal(await page.getByText('Only on server B',{exact:true}).count(),0);
      assert.equal(await page.getByRole('link',{name:'Late A category'}).getAttribute('href'),`#channel/${categoryId}`);
      await original.click();
      assert.equal(await editorText(reply),'');
      await selectServer(alternate);
      await page.getByRole('navigation').getByRole('link',{name:'Only on server B'}).click();
      await page.reload(); // The verified B choice and B cookie win over the runtime A default.
      await page.getByRole('heading',{name:'Only on server B'}).waitFor();
      await selectServer(apiOrigin);
      await original.click();
      await reply.fill('Unsent reply');
      await page.setViewportSize({width:375,height:800});
      await page.getByRole('button',{name:'Workspace',exact:true}).click();
      const drawer = page.getByRole('dialog',{name:'Workspace navigation'});
      await drawer.getByRole('button',{name:'Collapse General'}).click();
      assert.equal(await drawer.getByRole('link',{name:'First offline message'}).count(),0);
      await drawer.getByRole('button',{name:'Expand General'}).click();
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,'drawer-375.png')});
      await page.keyboard.press('Escape');
      assert(!(await drawer.isVisible()));
      await page.getByRole('button',{name:'Workspace',exact:true}).click();
      await drawer.getByRole('link',{name:'New thread'}).and(drawer.locator('[href="#channel/general"]')).click();
      await page.getByLabel('New thread in General').fill('Another project');
      await page.getByRole('button',{name:/^(Start thread|Send message)$/}).click();
      await page.getByRole('heading',{name:'Another project'}).waitFor();
      await page.setViewportSize({width:1100,height:800});
      await page.getByRole('navigation').getByRole('link',{name:'First offline message'}).click();
      await page.getByRole('heading',{name:'First offline message'}).waitFor();
      assert.equal(page.url(),first);
      assert.equal(await editorText(page.getByLabel('Your message')),'Unsent reply');
      const adapterPost = async (route,body) => {
        const response = await fetch(apiOrigin+'/adapter/'+route,{method:'POST',headers:{Origin:apiOrigin,Authorization:'Bearer '+process.env.ROTHCOLD_AGENT_ADAPTER_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body)});
        assert.equal(response.status,200); return response.json();
      };
      const old = await adapterPost('claim',{});
      assert.equal(old.text,'First offline message');
      await adapterPost('admission',{id:old.id,accepted:false});
      const recovery = page.getByText('Stop waiting and continue in this thread',{exact:true});
      await recovery.click();
      await page.locator('.recovery q',{hasText:offlineReply}).waitFor();
      await page.getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal((await adapterPost('claim',{})).text,'Another project');
      assert.equal(await adapterPost('claim',{}),null);
      await recovery.click();
      await assertLayout(page,320,420,'#turns, .recovery','.recovery summary, .recovery button');
      for (const width of [1100,375]) {
        await page.setViewportSize({width,height:800});
        await page.getByRole('button',{name:'Confirm and continue'}).scrollIntoViewIfNeeded();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,`recovery-${width}.png`)});
      }
      await page.getByRole('button',{name:'Confirm and continue'}).click();
      await page.getByText('Stopped waiting. The outcome of this turn is still unknown.',{exact:true}).waitFor();
      const next = await adapterPost('claim',{});
      assert.equal(next.chat,old.chat); assert.equal(next.text,offlineReply);
      await adapterPost('final',{chat:old.chat,id:old.id,text:'Late original answer'});
      await page.locator('article').filter({hasText:'First offline message'}).getByText('Late original answer',{exact:true}).waitFor();
      assert.equal(await editorText(page.getByLabel('Your message')),'Unsent reply');
      assert.equal(page.url(),first);
      await page.setViewportSize({width:1100,height:800});

      // This response commits the old first message but must leave a replacement draft alone.
      const general = page.getByRole('navigation',{name:'Categories'}).getByRole('link',{name:'General',exact:true});
      const directory = page.getByRole('link',{name:'Threads',exact:true});
      const firstMessage = page.getByLabel('New thread in General');
      let firstCommitted, releaseFirst;
      const committed = new Promise(resolve => { firstCommitted = resolve; });
      const heldFirst = new Promise(resolve => { releaseFirst = resolve; });
      await page.route('**/api/chats', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        assert.equal(response.status(),202);
        firstCommitted();
        await heldFirst;
        await route.fulfill({response});
      });
      await general.click();
      await firstMessage.fill('Committed old first message');
      await page.getByRole('button',{name:/^(Start thread|Send message)$/}).click();
      await committed;
      await changeServer();
      await cancel.click();
      await directory.click();
      await firstMessage.fill('Newer first-message draft');
      const firstReceipt = page.waitForResponse(r => r.url().endsWith('/api/chats') && r.request().method() === 'POST');
      releaseFirst();
      await (await firstReceipt).finished();
      await settings();
      await directory.click();
      assert.equal(await editorText(firstMessage),'Newer first-message draft');
      await page.unroute('**/api/chats');

      // A create receipt from the old workspace must leave the entire retry draft intact.
      const createAttempts = [];
      let attachedCommitted, releaseAttached;
      const committedAttached = new Promise(resolve => { attachedCommitted = resolve; });
      const heldAttached = new Promise(resolve => { releaseAttached = resolve; });
      const attachedTitle = 'Delayed start with an attachment';
      const picker = page.locator('#create input[type=file]');
      const attachment = page.getByRole('list', {name:'Pending attachments'}).getByText('create-retry.txt', {exact:true});
      const holdAttached = async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const input = route.request().postDataJSON();
        const response = await route.fetch();
        createAttempts.push({input, status:response.status()});
        if (createAttempts.length === 1) { attachedCommitted(); await heldAttached; }
        await route.fulfill({response});
      };
      const createPost = r => r.url().endsWith('/api/chats') && r.request().method() === 'POST';
      await page.route('**/api/chats', holdAttached);
      try {
        await firstMessage.fill(attachedTitle);
        await picker.setInputFiles({name:'create-retry.txt', mimeType:'text/plain', buffer:Buffer.from('fixture')});
        await attachment.waitFor();
        await page.getByRole('button',{name:'Start thread'}).click();
        await committedAttached;
        assert.equal(createAttempts[0].status, 202);
        assert.equal(createAttempts[0].input.attachments.length, 1);
        await changeServer();
        await cancel.click();
        await directory.click();
        const receipt = page.waitForResponse(createPost);
        releaseAttached();
        await (await receipt).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await editorText(firstMessage), attachedTitle);
        await attachment.waitFor({timeout:3000});
        const retry = page.waitForResponse(createPost);
        await page.getByRole('button',{name:'Start thread'}).click();
        assert.equal((await retry).status(), 200);
        const input = createAttempts[0].input;
        assert.deepEqual(createAttempts, [{input,status:202}, {input,status:200}]);
        await page.getByRole('heading',{name:attachedTitle,exact:true}).waitFor();
        assert.equal(new URL(page.url()).hash, '#'+input.id);
        await general.click();
        const row = page.locator('.category-threads').getByRole('link',{name:attachedTitle,exact:true});
        await row.waitFor();
        assert.equal(await row.count(), 1);
        assert.equal(await editorText(firstMessage), '');
        assert.equal(await attachment.count(), 0);
      } finally {
        releaseAttached();
        await page.unroute('**/api/chats', holdAttached);
      }

      // Even when the category form remounts at the same hash, a round trip through
      // a different thread must invalidate automatic navigation from a delayed start.
      await page.setViewportSize({width:1440,height:550});
      const feed = page.locator('.category-pane .pane-scroll');
      const rows = feed.locator('.category-threads');
      const categoryHash = await general.getAttribute('href');
      const backToCategory = page.getByRole('link',{name:'Back to General'});
      const start = page.getByRole('button',{name:'Start thread'});
      const created = await page.evaluate(async ({apiOrigin, categoryHash}) => {
        const ids = [];
        for (let i = 1; i <= 16; i++) {
          const r = await fetch('/api/chats', {method:'POST',headers:{'X-Rothcold-Server':apiOrigin,'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),channel:categoryHash.slice('#channel/'.length),text:`Reference fixture ${i}`})});
          if (r.status !== 202) throw new Error(`Seeding fixture ${i} failed: ${r.status}`);
          ids.push('#'+(await r.json()).id);
        }
        return ids;
      }, {apiOrigin, categoryHash});
      await page.reload();
      // Reload intentionally resets tab drafts; subsequent assertions use a new first message.
      await rows.getByRole('link',{name:'Reference fixture 16',exact:true}).waitFor();
      const target = rows.locator(`a[href="${created[0]}"]`);
      let releaseCreate, didCommit;
      const holdCreate = new Promise(resolve => { releaseCreate = resolve; });
      const createCommitted = new Promise(resolve => { didCommit = resolve; });
      const delayed = 'Delayed start must not take focus';
      await page.route('**/api/chats', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        assert.equal(response.status(),202);
        didCommit(await response.json());
        await holdCreate;
        await route.fulfill({response});
      });
      await firstMessage.fill(delayed);
      await start.click();
      const committedThread = await createCommitted;
      await target.click();
      await page.getByRole('heading',{name:'Reference fixture 1',exact:true}).waitFor();
      await backToCategory.click();
      await backToCategory.waitFor({state:'detached'});
      assert.equal(new URL(page.url()).hash,categoryHash);
      releaseCreate();
      await rows.getByRole('link',{name:delayed,exact:true}).waitFor();
      await page.waitForFunction(() => !document.querySelector('#create button.primary-action').disabled);
      assert.equal(new URL(page.url()).hash,categoryHash);
      assert.equal(await editorText(firstMessage),'');
      assert.equal(await rows.getByRole('link',{name:delayed,exact:true}).getAttribute('href'),'#'+committedThread.id);
      await page.unroute('**/api/chats');

      // Keep a real category feed scrolled away from the result, then open it by keyboard.
      const search = page.getByRole('button',{name:/Find threads or categories/});
      const filter = page.getByRole('textbox',{name:'Filter thread titles and categories'});
      await feed.evaluate(el => {el.scrollTop = 120;});
      assert(await target.evaluate(el => el.getBoundingClientRect().top >= el.closest('.pane-scroll').getBoundingClientRect().bottom));
      await search.click();
      await filter.fill('Reference fixture 1');
      await filter.press('ArrowDown');
      const searchResult = page.getByRole('dialog',{name:'Find threads or categories'}).getByRole('link',{name:'Reference fixture 1 General',exact:true});
      await searchResult.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading',{name:'Reference fixture 1',exact:true}).waitFor();
      const feedPosition = 120;
      assert.equal(await feed.count(),0);
      assert.equal(await firstMessage.count(),0);

      // Modified Back keeps native new-tab behavior without navigating or replacing the detail.
      const newTabPromise = page.context().waitForEvent('page');
      await backToCategory.click({modifiers:['ControlOrMeta']});
      const newTab = await newTabPromise;
      try {
        await newTab.getByRole('heading',{name:'General',exact:true}).waitFor();
        assert.equal(new URL(newTab.url()).hash,categoryHash);
        assert.equal(new URL(page.url()).hash,created[0]);
        assert.equal(await feed.count(),0);
      } finally {
        await newTab.close();
      }
      await page.bringToFront();
      const otherCategory = page.getByRole('navigation',{name:'Categories'}).getByRole('link',{name:'Late A category',exact:true});
      await otherCategory.click();
      await backToCategory.waitFor({state:'detached'});
      await page.getByRole('heading',{name:'Late A category',exact:true}).waitFor();
      assert(await otherCategory.evaluate(el => el === document.activeElement));
      assert.equal(await feed.evaluate(el => el.scrollTop),0);
      await general.click();
      await page.getByRole('heading',{name:'General',exact:true}).waitFor();
      await feed.evaluate(el => {el.scrollTop = 120;});
      await search.click();
      await filter.fill('Reference fixture 1');
      await searchResult.click();
      await backToCategory.click();
      await backToCategory.waitFor({state:'detached'});
      assert(await search.evaluate(el => el === document.activeElement));
      assert.equal(await feed.evaluate(el => el.scrollTop),feedPosition);
      await target.evaluate(el => el.scrollIntoView({block:'center'}));
      const rowPosition = await feed.evaluate(el => el.scrollTop);
      await target.click();
      await backToCategory.waitFor();
      assert(await page.locator('#thread-heading').evaluate(el => el === document.activeElement));
      await backToCategory.click();
      await backToCategory.waitFor({state:'detached'});
      assert(await target.evaluate(el => el === document.activeElement));
      assert.equal(await feed.evaluate(el => el.scrollTop),rowPosition);
      await target.click();
      await backToCategory.waitFor();
      await page.goBack();
      await backToCategory.waitFor({state:'detached'});
      assert(await target.evaluate(el => el === document.activeElement));
      assert.equal(await feed.evaluate(el => el.scrollTop),rowPosition);
      await page.goForward();
      await backToCategory.waitFor();
      assert.equal(await feed.count(),0);
      await backToCategory.click();
      await backToCategory.waitFor({state:'detached'});
      assert(await page.getByRole('heading',{name:'General',exact:true}).evaluate(el => el === document.activeElement));
      assert.equal(await feed.evaluate(el => el.scrollTop),rowPosition);

      // Explicit sidebar selection restores the feed without moving keyboard focus back to the old thread.
      await target.click();
      await backToCategory.waitFor();
      await general.focus();
      await page.keyboard.press('Enter');
      await backToCategory.waitFor({state:'detached'});
      assert(await general.evaluate(el => el === document.activeElement));
      assert.equal(await feed.evaluate(el => el.scrollTop),rowPosition);
      await page.keyboard.press('Enter');
      assert.equal(new URL(page.url()).hash,categoryHash);
      assert.equal(await page.locator('.conversation').count(),0);
      assert(await general.evaluate(el => el === document.activeElement));

      const sidebarTarget = page.locator('.sidebar .thread-links').locator(`a[href="${created[0]}"]`);
      await sidebarTarget.click();
      await backToCategory.click();
      await backToCategory.waitFor({state:'detached'});
      assert(await sidebarTarget.evaluate(el => el === document.activeElement));
      assert.equal(await feed.evaluate(el => el.scrollTop),rowPosition);

      await page.setViewportSize({width:390,height:550});
      await feed.evaluate(el => {el.scrollTop = 120;});
      await search.click();
      await filter.fill('Reference fixture 1');
      await searchResult.click();
      const back = page.getByRole('link',{name:'Back to General'});
      await back.click();
      await page.locator('.conversation').waitFor({state:'detached'});
      assert(await search.evaluate(el => el === document.activeElement));
      assert.equal(await feed.evaluate(el => el.scrollTop),120);
      await page.setViewportSize({width:1440,height:550});

      // An offscreen delivery remains unread until its reply is visible and the window has focus.
      await target.click();
      const turns = page.locator('#turns');
      const long = crypto.randomUUID();
      const chat = created[0].slice(1);
      const receipt = id => r => r.url().endsWith(`/api/chats/${chat}/read/${id}`) && r.status() === 200;
      const longRead = page.waitForResponse(receipt(long));
      await adapterPost('push',{id:long,chat,text:'Long thread delivery.\n\n'+'A separate paragraph to read.\n\n'.repeat(50)});
      await longRead;
      await turns.evaluate(el => {el.scrollTop = 0;});
      const delivery = crypto.randomUUID();
      const readRequests = [];
      const receiptUrl = `**/api/chats/${chat}/read/${delivery}`;
      await page.route(receiptUrl, route => { readRequests.push(route.request().method()); return route.continue(); });
      await adapterPost('push',{id:delivery,chat,text:'Thread delivery below the fold'});
      const replyBelow = page.getByText('Thread delivery below the fold',{exact:true});
      await replyBelow.waitFor();
      const sidebarThreads = page.locator('.sidebar .thread-links');
      const unreadRow = sidebarThreads.getByRole('link',{name:'Reference fixture 1 1 unread',exact:true});
      await unreadRow.waitFor();
      const poll = () => page.waitForResponse(r => r.url().endsWith('/api/notifications') && r.status() === 200);
      await page.waitForFunction(() => document.hasFocus());
      const offscreen = poll();
      await offscreen;
      assert.equal(await turns.evaluate(el => el.scrollTop),0);
      assert(await replyBelow.evaluate(el => el.getBoundingClientRect().top >= el.closest('#turns').getBoundingClientRect().bottom));
      assert.deepEqual(readRequests,[]);
      // Headless Chromium can report focus in more than one tab. Control just the
      // focus signal so both the actual IntersectionObserver and network writes run.
      const windowFocus = focused => page.evaluate(focused => {
        if (focused) Reflect.deleteProperty(document,'hasFocus');
        else Object.defineProperty(document,'hasFocus',{configurable:true,value:() => false});
        window.dispatchEvent(new FocusEvent(focused ? 'focus' : 'blur'));
      },focused);
      await windowFocus(false);
      try {
        const blurred = poll();
        await turns.evaluate(el => {el.scrollTop = el.scrollHeight;});
        await blurred;
        assert(await replyBelow.evaluate(el => el.getBoundingClientRect().bottom <= el.closest('#turns').getBoundingClientRect().bottom));
        assert.deepEqual(readRequests,[]);
        assert(await unreadRow.isVisible());
        const seen = page.waitForResponse(receipt(delivery));
        await windowFocus(true);
        await seen;
        await sidebarThreads.getByRole('link',{name:'Reference fixture 1',exact:true}).waitFor();
        assert.deepEqual(readRequests,['POST']);
      } finally {
        await windowFocus(true);
      }
      await page.unroute(receiptUrl);

      // Lose the receipt after the first message is durable. The retry uses its old
      // request ID even after opening and closing another thread.
      await backToCategory.click();
      await backToCategory.waitFor({state:'detached'});
      const retryTitle = 'Retry this first message exactly once';
      const retries = [];
      let recoveredId;
      await page.route('**/api/chats', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        retries.push(route.request().postDataJSON());
        const response = await route.fetch();
        assert.equal(response.status(),retries.length === 1 ? 202 : 200);
        const {id} = await response.json();
        if (retries.length === 1) {
          recoveredId = id;
          return route.abort();
        }
        assert.equal(id,recoveredId);
        await route.fulfill({response});
      });
      await firstMessage.fill(retryTitle);
      await start.click();
      await page.getByRole('status').getByText('Failed to fetch',{exact:true}).waitFor();
      await target.click();
      await backToCategory.waitFor();
      await backToCategory.click();
      await backToCategory.waitFor({state:'detached'});
      assert.equal(await editorText(firstMessage),retryTitle);
      await start.click();
      await page.getByRole('heading',{name:retryTitle,exact:true}).waitFor();
      const queued = await page.evaluate(async ({apiOrigin,id}) => {
        const r = await fetch(`/api/chats/${id}/turns`,{headers:{'X-Rothcold-Server':apiOrigin}});
        if (!r.ok) throw new Error(`Checking the saved thread failed: ${r.status}`);
        return r.json();
      },{apiOrigin,id:recoveredId});
      assert.equal(retries.length,2);
      assert.deepEqual(retries[0],retries[1]);
      await backToCategory.click();
      await rows.getByRole('link',{name:retryTitle,exact:true}).waitFor();
      assert.equal(await rows.getByRole('link',{name:retryTitle,exact:true}).count(),1);
      assert.deepEqual(queued.map(({id,text,state}) => ({id,text,state})),[{id:retries[0].id,text:retryTitle,state:'queued'}]);
      await page.unroute('**/api/chats');
      await page.setViewportSize({width:1100,height:800});

      // Leave A's logout pending while detaching its workspace, then sign in again on A.
      // Delay the upstream call until B is open to avoid A's normal expiry polling racing the setup.
      let logoutStarted, sendLogout, logoutCommitted, releaseLogout;
      const started = new Promise(resolve => { logoutStarted = resolve; });
      const sendOldLogout = new Promise(resolve => { sendLogout = resolve; });
      const revoked = new Promise(resolve => { logoutCommitted = resolve; });
      const heldLogout = new Promise(resolve => { releaseLogout = resolve; });
      await page.route('**/api/logout', async route => {
        logoutStarted();
        await sendOldLogout;
        const response = await route.fetch();
        assert.equal(response.status(),200);
        logoutCommitted();
        await heldLogout;
        await route.fulfill({response});
      });
      const me = key => fetch(apiOrigin+'/api/me',{headers:{Authorization:'Bearer '+key}});
      const signOut = page.getByRole('button',{name:'Sign out this device'});
      await settings();
      await signOut.click();
      await started;
      await directory.click(); // Remount Settings so its original form is no longer blocking Change server.
      await selectServer(alternate);
      sendLogout();
      await revoked;
      assert.equal((await me(cookie.value)).status,401);
      await changeServer();
      await address.fill(apiOrigin);
      await connect.click();
      await page.getByRole('heading',{name:'Sign in'}).waitFor();
      await owner.fill(process.env.ROTHCOLD_AGENT_OWNER_TOKEN);
      await page.getByRole('button',{name:'Open workspace'}).click();
      await page.getByRole('heading',{name:'General'}).waitFor();
      const newCookie = (await page.context().cookies()).find(entry => entry.name === cookie.name);
      assert(newCookie && newCookie.value !== cookie.value);
      await firstMessage.fill('Draft after re-login on A');
      const oldLogoutReceipt = page.waitForResponse(r => r.url().endsWith('/api/logout'));
      releaseLogout();
      const oldLogout = await oldLogoutReceipt;
      await oldLogout.finished();
      assert.equal(await oldLogout.headerValue('set-cookie'),null);
      assert((await page.context().cookies()).some(entry => entry.name === cookie.name && entry.value === newCookie.value), 'late logout must leave the new cookie intact');
      assert.equal((await me(newCookie.value)).status,200);
      await settings();
      await directory.click();
      assert.equal(await editorText(firstMessage),'Draft after re-login on A');
      await page.unroute('**/api/logout');

      await page.setViewportSize({width:375,height:800});
      await settings();
      await signOut.click();
      await page.getByRole('heading',{name:'Sign in'}).waitFor();
      assert.equal((await me(newCookie.value)).status,401);
      await page.reload();
      await page.getByRole('heading',{name:'Sign in'}).waitFor();
      assert.deepEqual(outsideOrigins, []);
      assert.deepEqual(errors, []);
      return;
    }
    await page.getByRole('link',{name:'Notifications 0 unread'}).click();
    await page.getByRole('button',{name:'Enable browser alerts'}).click();
    await page.getByRole('button',{name:'Turn off browser alerts'}).waitFor();
    await page.getByRole('link',{name:'Threads',exact:true}).click();
    await page.getByText('New category',{exact:true}).click();
    await page.getByLabel('Category name').fill('Library');
    await page.getByRole('button',{name:'Create category'}).click();
    await page.getByRole('heading',{name:'Library'}).waitFor();
    const attempts = [];
    await page.route('**/api/chats', async route => {
      if (route.request().method() === 'POST') {
        attempts.push(route.request().postDataJSON());
        if (attempts.length === 1) {
          assert.equal((await route.fetch()).status(), 202);
          return route.abort(); // Server committed; the browser lost the receipt.
        }
      }
      return route.continue();
    });
    await page.getByLabel('New thread in Library').fill('What should I read first?');
    await page.getByRole('button',{name:/^(Start thread|Send message)$/}).click();
    await page.getByText('Failed to fetch',{exact:true}).waitFor();
    await page.getByRole('link',{name:'General',exact:true}).click();
    await page.getByRole('heading',{name:'General'}).waitFor();
    await page.getByRole('link',{name:'Library',exact:true}).click();
    await page.getByRole('heading',{name:'Library'}).waitFor();
    await assertLayout(page,320,420,'.pane-scroll, #create','#create [role=textbox], #create button');
    for (const width of [1100,375]) {
      await page.setViewportSize({width,height:800});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,`channel-${width}.png`),fullPage:true});
    }
    assert.equal(await editorText(page.getByLabel('New thread in Library')),'What should I read first?');
    await page.getByRole('button',{name:/^(Start thread|Send message)$/}).click();
    await page.getByRole('heading',{name:'What should I read first?'}).waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    await page.getByText('Accepted by Hermes.',{exact:false}).waitFor();
    await page.getByText('📖 Reading src/main.rs',{exact:false}).waitFor();
    await page.locator('.interim-note strong',{hasText:'summary'}).waitFor();
    await page.getByRole('button',{name:'Approve for session'}).waitFor();
    await assertLayout(page,320,420,'#turns, .activity-list','.approval-actions button');
    for (const width of [1100,375]) {
      await page.setViewportSize({width,height:800});
      await page.locator('.approval-actions').scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,`approval-${width}.png`)});
    }
    const approvalEditor = page.getByRole('textbox', {name:'Your message'});
    await approvalEditor.pressSequentially('/approve session');
    const decision = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/turns'));
    await approvalEditor.press('Enter');
    const approved = (await decision).postDataJSON();
    assert.equal(approved.text, '/approve session');
    assert(approved.approval, 'the slash draft is pinned to the live approval');
    await page.getByText('Hermes received your decision: session.',{exact:false}).waitFor();
    assert.equal(await page.locator('article').count(),1);
    for (const width of [1100,375]) {
      await page.setViewportSize({width,height:800});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,`working-${width}.png`),fullPage:true});
    }
    const url = page.url();
    const rename = page.getByRole('button',{name:'Rename thread'});
    const title = page.getByRole('textbox',{name:'Thread title'});
    const save = page.getByRole('button',{name:'Save title'});
    await rename.click();
    assert.equal(await title.inputValue(),'What should I read first?');
    await title.fill('Discard this name');
    await title.press('Escape');
    assert(await rename.evaluate(el => document.activeElement === el));
    await rename.click();
    assert.equal(await title.inputValue(),'What should I read first?');
    await title.fill('  ');
    assert(await save.isDisabled());
    await title.fill('Library reading list');
    await assertLayout(page,320,420,'.pane-head','.pane-head input, .pane-head button');
    for (const width of [1100,375]) {
      await page.setViewportSize({width,height:800});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,`rename-${width}.png`),fullPage:true});
    }
    await title.press('Enter');
    await page.getByRole('heading',{name:'Library reading list'}).waitFor();
    assert.equal(page.url(),url);
    await page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link',{name:'Category: Library',exact:true}).click();
    await page.locator('.category-threads').getByRole('link',{name:'Library reading list'}).click();
    await page.setViewportSize({width:1100,height:800});
    await page.getByRole('heading',{name:'Library reading list'}).waitFor();
    console.log('viewing'); // Release the fixture while the owner stays in the thread.
    for await (const signal of process.stdin) { assert.equal(signal.toString(), 'final\n'); break; }
    const fresh = page;
    await fresh.getByRole('heading',{name:'Library reading list'}).waitFor();
    await fresh.locator('.markdown h3',{hasText:'Reading plan'}).waitFor();
    await fresh.getByText('Start with <chapter one> and',{exact:false}).waitFor();
    await fresh.locator('.markdown strong',{hasText:'read'}).waitFor();
    await fresh.locator('.markdown code',{hasText:'Cargo.toml'}).waitFor();
    await fresh.locator('.markdown pre code',{hasText:'fn main() {}'}).waitFor();
    await fresh.locator('.markdown table td',{hasText:'ok'}).waitFor();
    assert.equal(await fresh.locator('chapter').count(), 0);
    await fresh.locator('.activity-details summary',{hasText:'Activity (3 updates)'}).waitFor();
    assert.equal(await fresh.locator('article').count(),1);
    await fresh.waitForResponse(r => r.url().includes('/read/') && r.status() === 200);
    await fresh.getByRole('link',{name:'Notifications 0 unread'}).waitFor();
    assert.equal(await fresh.evaluate(() => window.sentAlerts.length),0);
    const push = async text => {
      const result = await fetch(apiOrigin+'/adapter/push',{method:'POST',headers:{Origin:apiOrigin,Authorization:'Bearer '+process.env.ROTHCOLD_AGENT_ADAPTER_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),chat:new URL(url).hash.slice(1),text})});
      assert.equal(result.status,200);
    };
    for (const width of [1100,375]) {
      await fresh.setViewportSize({width,height:800});
      assert(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,`${width}.png`),fullPage:true});
    }
    await fresh.getByRole('button',{name:'Workspace',exact:true}).click();
    await push('Delivery with drawer open.');
    const inbox = fresh.getByRole('link',{name:'Notifications 1 unread'});
    await inbox.waitFor();
    await fresh.waitForFunction(() => window.sentAlerts.length === 1);
    assert.equal(await fresh.evaluate(() => window.sentAlerts[0].body),'You have a new message.');
    await inbox.click();
    const event = fresh.getByRole('link',{name:'Library · Unread Library reading list'});
    assert.equal(await event.getAttribute('href'),new URL(url).hash);
    for (const width of [1100,375]) {
      await fresh.setViewportSize({width,height:800});
      assert(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await assertGlobalPane(fresh,'Inbox');
      if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,`inbox-${width}.png`),fullPage:true});
    }
    await event.click();
    await fresh.getByRole('heading',{name:'Library reading list'}).waitFor();
    assert.equal(fresh.url(), url);
    await fresh.getByText('Delivery with drawer open.',{exact:true}).waitFor();
    await fresh.waitForResponse(r => r.url().includes('/read/') && r.status() === 200);
    await push('Long delivery.\n\n'+'A paragraph of reading.\n\n'.repeat(65));
    await fresh.waitForResponse(r => r.url().includes('/read/') && r.status() === 200);
    await fresh.locator('#turns').evaluate(el => {el.scrollTop=0;});
    await push('Below the fold.');
    await fresh.waitForFunction(() => window.sentAlerts.length === 2);
    assert.equal(await fresh.locator('#turns').evaluate(el => el.scrollTop),0);
    await fresh.locator('#turns').evaluate(el => {el.scrollTop=el.scrollHeight;});
    await fresh.waitForResponse(r => r.url().includes('/read/') && r.status() === 200);
    await fresh.getByRole('button',{name:'Workspace',exact:true}).click();
    await fresh.getByRole('link',{name:'Notifications 0 unread'}).click();
    await fresh.getByRole('button',{name:'Turn off browser alerts'}).click();
    await fresh.getByRole('button',{name:'Enable browser alerts'}).waitFor();
    await assertLayout(fresh,320,420,'.pane-scroll','.pane-scroll button, .items a');
    await fresh.locator('.inbox-pane').getByRole('link',{name:/Library reading list/}).first().click();
    await fresh.getByRole('heading',{name:'Library reading list'}).waitFor();
    await fresh.unroute('**/api/chats');
    await fresh.setViewportSize({width:1440,height:900});
    const categoryList = fresh.locator('.category-threads');
    const search = fresh.getByRole('button',{name:/Find threads or categories/});
    const searchDialog = fresh.getByRole('dialog',{name:'Find threads or categories'});
    const filter = searchDialog.getByRole('textbox',{name:'Filter thread titles and categories'});
    const backToCategory = fresh.getByRole('link',{name:'Back to Library'});
    const libraryHash = await fresh.locator('.sidebar').getByRole('link',{name:'Library',exact:true}).getAttribute('href');
    const categoryDraft = fresh.getByLabel('New thread in Library');
    const sendFirst = fresh.getByRole('button',{name:'Start thread'});
    const threadDraft = fresh.getByLabel('Your message');
    const fixtureTitles = ['Compare the reference editions', 'Check citations for chapter two', 'Outline the architecture notes'];
    for (const name of ['Research', 'Dev notes']) {
      await fresh.getByText('New category',{exact:true}).click();
      await fresh.getByLabel('Category name').fill(name);
      await fresh.getByRole('button',{name:'Create category'}).click();
      await fresh.getByRole('heading',{name,exact:true}).waitFor();
    }
    await fresh.locator('.sidebar').getByRole('link',{name:'Library',exact:true}).click();
    const ids = [];
    for (const subject of fixtureTitles) {
      await categoryDraft.fill(subject);
      await sendFirst.click();
      await fresh.getByRole('heading',{name:subject,exact:true}).waitFor();
      const final = fresh.waitForResponse(r => r.url().includes('/read/') && r.status() === 200);
      await fresh.getByRole('heading',{name:'Notes for the working draft'}).waitFor();
      await final;
      ids.push(new URL(fresh.url()).hash);
      await backToCategory.click();
      await categoryDraft.waitFor();
    }
    await fresh.getByRole('link',{name:'Notifications 0 unread'}).waitFor();
    const added = await fetch(apiOrigin+'/adapter/push',{method:'POST',headers:{Origin:apiOrigin,Authorization:'Bearer '+process.env.ROTHCOLD_AGENT_ADAPTER_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),chat:ids[0].slice(1),text:'Cross-references are ready to review.'})});
    assert.equal(added.status,200);
    const unreadRow = categoryList.getByRole('link',{name:fixtureTitles[0]+' 1 unread'});
    await unreadRow.waitFor();
    assert.equal(await categoryList.getByRole('link').count(),4);
    await fresh.getByRole('heading',{name:'Library',exact:true}).waitFor();
    const assertMain = async (view, width) => {
      if (width > 760) await fresh.locator('#workspace > .sidebar').waitFor();
      const boxes = await fresh.evaluate(({view,width}) => {
        const selectors = ['.command-bar'];
        if (width > 760) selectors.push('#workspace > .workspace-rail','#workspace > .sidebar');
        selectors.push(view);
        return selectors.map(selector => {
          const {x,y,width,right} = document.querySelector(selector).getBoundingClientRect();
          return {x,y,width,right};
        });
      },{view,width});
      const main = boxes.at(-1);
      assert.equal(boxes[0].width,width);
      if (width > 760) {
        assert(boxes[1].width >= 56 && boxes[1].width <= 68);
        for (let i = 1; i < 3; i++) {
          assert.equal(boxes[i].right,boxes[i+1].x);
          assert.equal(boxes[i].y,boxes[i+1].y);
        }
      } else assert.equal(main.x,0);
      assert.equal(main.right,width);
      assert.equal(await fresh.locator(view === '.conversation' ? '.category-pane, #create' : '.conversation, #compose').count(),0);
      assert.equal(await fresh.locator('#create, #compose').count(),1);
    };
    const colors = selector => fresh.locator(selector).evaluate(el => {
      const style = getComputedStyle(el);
      return [style.backgroundColor,style.color];
    });
    const warm = ['rgb(231, 198, 143)','rgb(32, 39, 43)'];
    await fresh.mouse.move(1,1);
    await assertMain('.category-pane',1440);
    assert.equal((await colors('.command-bar'))[0],'rgb(44, 64, 82)');
    assert.equal((await colors('.category-pane'))[0],'rgb(28, 36, 43)');
    assert.deepEqual(await colors('#create button.primary-action'),warm);
    assert.deepEqual(await colors('.category-threads .badge'),['rgb(44, 64, 82)','rgb(168, 207, 220)']);
    if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,'category-1440x900.png')});
    await editorPaste(categoryDraft, 'Keep this **category** draft.');
    await categoryList.getByRole('link',{name:fixtureTitles[2],exact:true}).click();
    const note = fresh.getByRole('heading',{name:'Notes for the working draft'});
    await note.waitFor();
    await assertMain('.conversation',1440);
    assert.equal(await fresh.locator('.sidebar').getByRole('link',{name:fixtureTitles[2]}).getAttribute('aria-current'),'page');
    assert.equal((await colors('.conversation'))[0],'rgb(25, 33, 39)');
    assert.deepEqual(await colors('#compose button.primary-action'),warm);
    const primary = fresh.locator('#compose button.primary-action');
    await primary.hover();
    assert.equal((await colors('#compose button.primary-action'))[0],'rgb(240, 214, 170)');
    await fresh.mouse.down();
    assert.equal((await colors('#compose button.primary-action'))[0],'rgb(206, 175, 121)');
    await fresh.mouse.move(1,1); await fresh.mouse.up();
    await note.scrollIntoViewIfNeeded();
    if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,'thread-1440x900.png')});

    await threadDraft.fill('Keep this thread reply.');
    await fresh.keyboard.press('Control+k');
    await filter.waitFor();
    assert(await filter.evaluate(el => el === document.activeElement));
    await filter.fill('no such thread');
    await searchDialog.getByText('0 matches').waitFor();
    await fresh.keyboard.press('Escape');
    await searchDialog.waitFor({state:'hidden'});
    assert.equal(new URL(fresh.url()).hash,ids[2]);
    assert.equal(await editorText(threadDraft),'Keep this thread reply.');
    await search.click();
    assert.equal(await filter.inputValue(),'');
    await filter.fill('citations library');
    await filter.press('ArrowDown');
    const result = searchDialog.getByRole('link',{name:fixtureTitles[1]+' Library'});
    if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,'workspace-search-1440x900.png')});
    assert(await result.evaluate(el => el === document.activeElement));
    await fresh.keyboard.press('Enter');
    await fresh.getByRole('heading',{name:fixtureTitles[1],exact:true}).waitFor();
    await backToCategory.click();
    await backToCategory.waitFor({state:'detached'});
    await categoryList.getByRole('link',{name:fixtureTitles[1]}).waitFor();
    assert.equal(new URL(fresh.url()).hash,libraryHash);
    assert(await search.evaluate(el => el === document.activeElement));
    assert.equal(await editorText(categoryDraft),'Keep this category draft.');
    assert.equal(await categoryDraft.locator('strong').innerText(), 'category');
    await categoryList.getByRole('link',{name:fixtureTitles[2]}).click();
    await threadDraft.waitFor();
    assert.equal(await editorText(threadDraft),'Keep this thread reply.');
    await fresh.setViewportSize({width:820,height:1024});
    await assertMain('.conversation',820);
    if (process.env.SHOTS) {
      await note.scrollIntoViewIfNeeded();
      await fresh.screenshot({path:path.join(process.env.SHOTS,'thread-820x1024.png')});
    }
    await fresh.setViewportSize({width:390,height:844});
    await assertMain('.conversation',390);
    await note.scrollIntoViewIfNeeded();
    if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,'thread-390x844.png')});
    await fresh.getByRole('link',{name:'Back to Library'}).click();
    await unreadRow.waitFor();
    await assertMain('.category-pane',390);
    assert.equal(await editorText(categoryDraft),'Keep this category draft.');
    assert.equal(await categoryDraft.locator('strong').innerText(), 'category');
    if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,'category-390x844.png')});
    await search.click();
    await filter.fill('general');
    await searchDialog.getByRole('link',{name:'General Category'}).click();
    await fresh.getByRole('heading',{name:'General',exact:true}).waitFor();
    await search.click();
    await filter.fill('Library');
    await searchDialog.getByRole('button',{name:'Cancel search'}).click();
    assert.equal(new URL(fresh.url()).hash,'#channel/general');
    await search.click();
    await filter.fill('Compare the reference');
    await searchDialog.getByRole('link',{name:fixtureTitles[0]+' Library'}).click();
    await fresh.getByText('Cross-references are ready to review.').waitFor();
    await fresh.waitForResponse(r => r.url().includes('/read/') && r.status() === 200);
    await fresh.getByRole('link',{name:'Back to Library'}).click();
    await fresh.locator('.conversation').waitFor({state:'detached'});
    assert(await search.evaluate(el => el === document.activeElement));
    await categoryList.getByRole('link',{name:'Library reading list',exact:true}).click();
    await fresh.getByRole('heading',{name:'Library reading list',exact:true}).waitFor();
    const longTitle = '资料整理与阅读笔记：'.repeat(5) + ' reading-notes-and-references';
    await rename.click();
    await title.fill(longTitle);
    await title.press('Enter');
    const heading = fresh.getByRole('heading',{name:longTitle,exact:true});
    await heading.waitFor();
    const english = 'A readable thread leaves room to follow the argument and find the next step. '.repeat(5).trim();
    const chinese = '这一段关于阅读与整理的中文笔记用来确认长句在窄屏上自然换行，同时保留标点和段落之间的空白。'.repeat(5);
    const token = 'SegmentWithoutSpaces'.repeat(12);
    await push(`### Reading measure fixture\n\n${english}\n\n${chinese}\n\n${token}\n\n\`\`\`text\n${token}\n\`\`\`\n\n| Column one | Column two | Column three |\n|---|---|---|\n| A note | ${token} | ${chinese} |`);
    const reading = fresh.locator('.markdown',{has:fresh.getByRole('heading',{name:'Reading measure fixture'})});
    await reading.waitFor();
    const editor = fresh.getByLabel('Your message');
    const draft = 'Review the English notes.\n核对中文段落的标点。';
    await editor.fill(draft.split('\n')[0]);
    await editor.press('End');
    await editor.press('Shift+Enter');
    await fresh.keyboard.type(draft.split('\n')[1]);
    const measures = [];
    const drafts = [];
    for (const [width,height] of [[320,420],[375,800],[390,844],[390,360],[760,800],[761,800],[768,1024],[820,1180],[844,390],[1024,768],[1100,800],[1440,900]]) {
      await assertLayout(fresh,width,height,'.pane-head, #turns, #compose, .sidebar',width <= 760 ? '.breadcrumb, .thread-back, .conversation .pane-head button, #compose [role=textbox], #compose button, .mobile-nav, .search-trigger' : '');
      const geometry = await reading.evaluate(el => {
        const box = selector => document.querySelector(selector).getBoundingClientRect();
        const text = el.querySelector('p');
        const style = getComputedStyle(text);
        const body = el.getBoundingClientRect();
        const heading = box('#thread-heading');
        const turns = box('#turns');
        const compose = box('#compose');
        const send = box('#compose button.primary-action');
        const pane = box('.conversation');
        return {measure:body.width,left:body.left,headingLeft:heading.left,
          turnsBottom:turns.bottom,turnsHeight:turns.height,composeTop:compose.top,composeLeft:compose.left,
          composeRight:compose.right,sendBottom:send.bottom,paneLeft:pane.left,paneWidth:pane.width,avatar:document.querySelector('.avatar').getBoundingClientRect().right,font:parseFloat(style.fontSize),leading:parseFloat(style.lineHeight)};
      });
      assert(geometry.font >= 16 && geometry.leading / geometry.font >= 1.6, JSON.stringify(geometry));
      assert(Math.abs(geometry.headingLeft - geometry.composeLeft) <= 1, JSON.stringify(geometry));
      assert(geometry.left > geometry.headingLeft && geometry.left > geometry.avatar, JSON.stringify(geometry));
      assert(geometry.composeLeft >= geometry.paneLeft && geometry.composeRight <= geometry.paneLeft + geometry.paneWidth + 1, JSON.stringify(geometry));
      const padLeft = geometry.composeLeft - geometry.paneLeft;
      const padRight = geometry.paneLeft + geometry.paneWidth - geometry.composeRight;
      assert(Math.abs(padLeft - padRight) <= 2 && padLeft <= 44, `${width}×${height}: pad ${padLeft}/${padRight}`);
      if (width === 1440) {
        assert(geometry.measure >= geometry.paneWidth - 140, `1440px should use full width with light padding: ${JSON.stringify(geometry)}`);
      }
      assert(geometry.turnsHeight >= 72 && geometry.turnsBottom <= geometry.composeTop && geometry.sendBottom <= height, `${width}×${height}: ${JSON.stringify(geometry)}`);
      measures.push(`${width}×${height}: ${Math.round(geometry.measure)}px wide / ${Math.round(geometry.turnsHeight)}px visible timeline`);
      if (width <= 390 && height <= 420) {
        const box = await shortDraftGeometry(heading, editor, draft);
        drafts.push(`${width}×${height}: ${box.width}×${box.height}px editor, ${Math.round(box.timeline)}px timeline`);
      }
      const code = reading.locator('pre');
      assert(await code.evaluate(el => el.scrollWidth > el.clientWidth), 'long code scrolls inside its own block');
      if (process.env.SHOTS && [320,375,390,1100,1440].includes(width)) {
        const sample = height === 844 ? reading.locator('p').nth(1) : reading.getByRole('heading',{name:'Reading measure fixture'});
        await sample.scrollIntoViewIfNeeded();
        await fresh.screenshot({path:path.join(process.env.SHOTS,`reading-${width}x${height}.png`)});
      }
    }
    assert(await fresh.locator('.sidebar').getByRole('link',{name:new RegExp(longTitle)}).locator('.thread-title').evaluate(el => {
      const style = getComputedStyle(el);
      return el.scrollWidth > el.clientWidth && el.clientHeight < 2 * parseFloat(style.lineHeight) && style.textOverflow === 'ellipsis';
    }), 'the long sidebar title is a single ellipsized line with its full accessible name');
    const lines = await reading.evaluate(el => [...el.querySelectorAll('p')].slice(0,2).map(p => {
      const node = p.firstChild;
      const range = new Range();
      range.setStart(node,0);
      range.setEnd(node,1);
      const firstTop = range.getBoundingClientRect().top;
      for (let end = 2; end <= node.length; end++) {
        range.setEnd(node,end);
        if (range.getClientRects().length > 1 && [...range.getClientRects()].some(r => r.top > firstTop + 4)) return end - 1;
      }
      return node.length;
    }));
    assert(lines[0] >= 43 && lines[1] >= 23, `First lines (English / Chinese): ${lines.join(' / ')}`);
    await fresh.setViewportSize({width:761,height:800});
    const sidebar = fresh.locator('#workspace > .sidebar');
    const opener = fresh.getByRole('button',{name:'Workspace',exact:true});
    await sidebar.waitFor();
    assert.equal(await opener.count(), 0);
    await fresh.setViewportSize({width:760,height:800});
    await opener.waitFor();
    assert.equal(await sidebar.count(), 0);
    await opener.focus();
    await fresh.keyboard.press('Enter');
    const breakpointDrawer = fresh.getByRole('dialog',{name:'Workspace navigation'});
    await breakpointDrawer.waitFor();
    for (const key of ['Tab','Tab','Shift+Tab']) {
      await fresh.keyboard.press(key);
      assert(await breakpointDrawer.evaluate(el => el.contains(document.activeElement)));
    }
    await fresh.keyboard.press('Escape');
    await breakpointDrawer.waitFor({state:'hidden'});
    assert(await opener.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
    await fresh.setViewportSize({width:390,height:360});
    await rename.click();
    assert.equal(await title.inputValue(),longTitle);
    await save.scrollIntoViewIfNeeded();
    assert(await save.evaluate(el => {
      const parent = el.closest('.pane-head').getBoundingClientRect();
      const button = el.getBoundingClientRect();
      return button.top >= parent.top && button.bottom <= parent.bottom;
    }), 'the long heading scrolls to reveal its full action on short screens');
    await title.press('Escape');
    assert(await rename.evaluate(el => el === document.activeElement));
    await fresh.evaluate(() => { document.documentElement.style.fontSize = '125%'; });
    for (const [width,height] of [[390,360],[320,420]]) {
      await assertLayout(fresh,width,height,'.pane-head, #turns, #compose','#compose button, #compose [role=textbox]');
      const scaled = await shortDraftGeometry(heading, editor, draft);
      assert(scaled.font >= 20);
      drafts.push(`${width}×${height} at 125% text: ${scaled.width}×${scaled.height}px editor, ${Math.round(scaled.timeline)}px timeline`);
      if (process.env.SHOTS) {
        await reading.getByRole('heading',{name:'Reading measure fixture'}).scrollIntoViewIfNeeded();
        await fresh.screenshot({path:path.join(process.env.SHOTS,`reading-${width}x${height}-text125.png`)});
      }
    }
    await assertLayout(fresh,390,360,'.pane-head, #turns, #compose','#compose button');
    const geometryBeforeLimit = await fresh.locator('#compose').boundingBox();
    await editorPaste(editor, 'a'.repeat(8001));
    const warning = fresh.locator('#compose .composer-actions').getByRole('alert');
    await warning.waitFor();
    const overLimitTimeline = await fresh.locator('#turns').boundingBox();
    const warningBox = await warning.boundingBox();
    assert(warningBox.y + warningBox.height <= 360);
    if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,'composer-limit-390x360-text125.png')});
    const geometryAfterLimit = await fresh.locator('#compose').boundingBox();
    assert(overLimitTimeline.height >= 72, `over-limit timeline has only ${overLimitTimeline.height}px; composer: ${geometryBeforeLimit.height}px before, ${geometryAfterLimit.height}px after`);
    console.error(`Over-limit geometry: ${overLimitTimeline.height}px visible timeline at 390×360 / 125% text.`);
    await assertLayout(fresh,320,420,'.pane-head, #turns, #compose','#compose button');
    await opener.focus();
    await fresh.keyboard.press('Tab');
    const focused = await fresh.evaluate(() => {
      const el = document.activeElement;
      const r = el.getBoundingClientRect();
      return el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid' && r.top >= 0 && r.bottom <= innerHeight;
    });
    assert(focused, 'keyboard focus ring must be visible at narrow width with larger text');
    console.error(`Workspace layout: ${measures.join('; ')}. Desktop first lines: ${lines.join(' / ')} characters (English / Chinese).`);
    console.error(`Draft geometry: ${drafts.join('; ')}. Exact 760/761 breakpoint and keyboard focus return verified.`);
    assert.deepEqual(outsideOrigins, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
