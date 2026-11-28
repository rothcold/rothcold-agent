const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { themeScreens } = require('./browser-theme.cjs');

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

async function exerciseSlashMenu(page, form, mobile, { post, pages }, hash) {
  const editor = form.getByRole('textbox');
  const menu = form.getByRole('listbox', {name:'Gateway suggestions'});
  const status = menu.getByRole('option', {name:'/status',exact:true});
  const skill = menu.getByRole('option', {name:'/sandbox-skill',exact:true});
  const snapshot = () => hash ? pages({type:'history', chat:hash.slice(1)}) : pages({type:'threads', include_archived:true});
  const before = await snapshot();
  await post('slash-catalog', {catalog:{commands:mobile ? ['status', 'stop'] : ['status', 'stop', 'sync'], skills:mobile ? ['sandbox-skill'] : ['sandbox-skill', 'sandbox-skill-extension']}});
  const cdp = await page.context().newCDPSession(page);
  try {
    if (mobile) {
      await page.setViewportSize({width:375,height:760});
      await cdp.send('Emulation.setTouchEmulationEnabled', {enabled:true});
    }
    await form.locator('[role=textbox][contenteditable=true]').waitFor();
    await editor.pressSequentially('/');
    await status.waitFor();
    assert.equal(await menu.getByRole('option', {name:/^\/(approve|deny)$/}).count(), 0);
    await editor.pressSequentially('s');
    assert.equal(await menu.getByRole('group', {name:'Commands'}).getByRole('option').count(), mobile ? 2 : 3);
    await menu.getByRole('group', {name:'Skills'}).getByRole('option', {name:'/sandbox-skill',exact:true}).waitFor();
    if (!mobile) {
      await editor.press('ArrowUp');
      assert.equal(await menu.getByRole('option').last().getAttribute('aria-selected'), 'true');
      await editor.press('ArrowDown');
      assert.equal(await menu.getByRole('option').first().getAttribute('aria-selected'), 'true');
      const statusIndex = (await menu.getByRole('option').allTextContents()).indexOf('/status');
      assert(statusIndex >= 0);
      for (let i=0; i<statusIndex; i++) await editor.press('ArrowDown');
      assert.equal(await status.getAttribute('aria-selected'), 'true');
      assert.equal(await editor.getAttribute('aria-activedescendant'), await status.getAttribute('id'));
    }
    const shot = mobile ? 'slash-reply-375.png' : 'slash-new-thread-1100.png';
    await assertLayout(page, mobile ? 375 : 1100, mobile ? 760 : 800, '.composer-slash-menu');
    if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS, shot)});
    await themeScreens(page, 'slash-menu', [
      ['.composer-slash-menu legend'], ['.composer-slash-menu [role="option"]'],
      ['.composer-slash-menu [aria-selected="true"]'],
    ]);
    if (mobile) {
      await assertLayout(page, 375, 420, '#compose, .composer-slash-menu');
      await page.setViewportSize({width:375,height:760});
      await editor.pressSequentially('and');
      assert.equal(await menu.getByRole('option').count(), 1);
      const tap = await skill.boundingBox();
      assert(tap && tap.height >= 44, JSON.stringify(tap));
      const touchPoints = [{x:tap.x+tap.width/2, y:tap.y+tap.height/2}];
      await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints});
      await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
      await menu.waitFor({state:'hidden'});
      assert.equal(await editorText(editor), '/sandbox-skill');
      await page.getByRole('link', {name:'Back to General'}).click();
      await page.locator(`.category-threads a[href="${hash}"]`).click();
      await editor.waitFor();
      assert.equal(await editorText(editor), '/sandbox-skill');
      assert.equal(await menu.count(), 0, 'restoring a draft must not reopen the slash menu');
    } else {
      await editor.press('Enter');
      await menu.waitFor({state:'hidden'});
      assert.equal(await editorText(editor), '/status');
      await editor.clear();
      await editor.pressSequentially('/sandbox-skill');
      const longer = menu.getByRole('option', {name:'/sandbox-skill-extension',exact:true});
      await longer.waitFor();
      assert.equal(await menu.getByRole('option').first().textContent(), '/sandbox-skill');
      assert.equal(await skill.getAttribute('aria-selected'), 'true');
      await editor.press('ArrowDown');
      assert.equal(await longer.getAttribute('aria-selected'), 'true');
      await editor.press('ArrowUp');
      assert.equal(await skill.getAttribute('aria-selected'), 'true');
      await editor.press('Enter');
      assert.equal(await editorText(editor), '/sandbox-skill');
      await editor.clear();
      await editor.pressSequentially('/sand');
      await skill.click();
      assert.equal(await editorText(editor), '/sandbox-skill');
      await editor.clear();
      await editor.pressSequentially('/s');
      await status.waitFor();
      await editor.press('Escape');
      assert.equal(await menu.count(), 0);
      assert.equal(await editorText(editor), '/s');
      await editor.clear();
      await editor.focus();
      await cdp.send('Input.imeSetComposition', {text:'/',selectionStart:1,selectionEnd:1});
      await editor.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', {
        key:'Enter', keyCode:229, isComposing:true, bubbles:true, cancelable:true,
      })));
      assert.equal(await menu.count(), 0, 'IME Enter must not select or submit');
      await cdp.send('Input.imeSetComposition', {text:'中文',selectionStart:2,selectionEnd:2});
      await cdp.send('Input.insertText', {text:'中文'});
      assert.equal(await editorText(editor), '中文');
      assert.equal(await menu.count(), 0);
      await editorPaste(editor, '/s');
      assert.equal(await menu.count(), 0, 'pasting a slash must not open the menu');
      await editor.clear();
      await editor.pressSequentially('body /s');
      assert.equal(await menu.count(), 0);
      await editor.clear();
      await form.getByRole('button', {name:'Code block',exact:true}).click();
      await editor.pressSequentially('/s');
      assert.equal(await editor.locator('pre').innerText(), '/s');
      assert.equal(await menu.count(), 0);
      await form.getByRole('button', {name:'Code block',exact:true}).click();
    }
    assert.deepEqual(await snapshot(), before, 'accepting, dismissing and composing must not submit');
    await editor.clear();
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', {enabled:false});
    await cdp.detach();
    await page.setViewportSize({width:1100,height:800});
  }
}

async function profilesAttachmentsAndMoves(page, origin, fixture) {
  const newThread = page.locator('#create');
  const reply = page.locator('#compose');
  const { image, wave, post, complete, pages } = fixture;
  const sourceId = (await fixture.nativeCall({ type:'create_category', name:'Research' })).id;
  const destinationId = (await fixture.nativeCall({ type:'create_category', name:'Archive' })).id;
  for (let i=0; i<14; i++) {
    const id = randomUUID();
    await fixture.nativeCall({type:'start_thread',channel:sourceId,message:{id,text:`Research history ${i+1}`}});
    await complete(id, `Research indexed ${i+1}`);
  }
  await page.reload();
  await page.getByRole('heading', {name:'General',exact:true}).waitFor();
  const video = path.join(__dirname, 'fixtures', 'video.webm');
  const markup = Buffer.from('<!doctype html><h1>Download only</h1>');
  const tray = page.getByRole('list', {name:'Pending attachments'});
  const sent = page.getByRole('list', {name:'Message attachments'});
  async function shot(name, containers, mobileHeight = 800) {
    for (const width of [1100, 375]) {
      await assertLayout(page, width, width === 375 ? mobileHeight : 800, containers);
      if (process.env.SHOTS) await themeScreens(page, name, [['h1']]);
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
  assert.match(media, /^blob:/);
  for (const [name, data] of [['sample.png', await readFile(image)], ['sample.wav', await readFile(wave)], ['video.webm', await readFile(video)]]) {
    const pending = page.waitForEvent('download');
    await sent.getByRole('button', {name:`Download ${name}`}).click();
    const saved = await pending;
    assert.equal(saved.suggestedFilename(), name);
    assert.deepEqual(await readFile(await saved.path()), data);
  }
  assert.equal(await sent.getByText('memo.html', {exact:true}).locator('xpath=ancestor::li').locator('img, iframe, video, audio, object').count(), 0);
  await sent.getByRole('button', {name:'Preview sample.png'}).click();
  const dialog = page.getByRole('dialog', {name:'sample.png'});
  await dialog.waitFor();
  await dialog.locator('img').waitFor();
  await page.waitForFunction(() => document.querySelector('.image-dialog[open] img')?.naturalWidth > 0);
  await shot('profile-attachments-lightbox', '.image-dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  const downloaded = page.waitForEvent('download');
  await sent.getByRole('button', {name:'Download memo.html'}).click();
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
  await destination.selectOption(sourceId);
  await shot('thread-move-offline', '.pane-head, #turns, #compose');
  await page.getByRole('button', {name:'Move', exact:true}).click();
  await page.getByRole('link', {name:'Back to Research'}).waitFor();
  assert.equal(page.url(), thread);
  const crumb = page.getByRole('navigation',{name:'Breadcrumb'});
  assert.deepEqual(await crumb.locator(':scope > *').allTextContents(),['Research','→','sample.png']);
  assert.equal(await editorText(reply.getByRole('textbox')), 'Draft follows the thread');
  await tray.getByText('sample.png', {exact:true}).waitFor();
  await tray.getByRole('button', {name:'Remove sample.png'}).click();
  const original = new URL(thread).hash.slice(1);
  await post('connect', {});
  await complete(original, 'The attachments reached the gateway.', 'Fixture commentary');
  await page.getByText('The attachments reached the gateway.', {exact:true}).waitFor();
  const backendAvatar = await fixture.avatar(await readFile(image));
  await post('profile', {backend:'hermes',kind:'hermes',name:'Passive fixture Hermes',avatar:backendAvatar.id});
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
  await agentAvatar.waitFor();
  const passive = await agentAvatar.getAttribute('src');
  await agentPicker.setInputFiles(image);
  await page.waitForFunction(old => {
    const avatar = document.querySelector('.profile-identity:last-of-type .avatar img');
    return !!avatar?.naturalWidth && avatar.getAttribute('src') !== old;
  }, passive);
  await page.getByLabel('Backend profile').selectOption('hermes');
  await page.getByRole('button', {name:'Sync from backend'}).click();
  await fixture.eventually(async () => {
    const sync = await post('claim', {backend:'hermes'});
    if (!sync?.sync_profile) return false;
    await post('profile', {backend:'hermes',kind:'hermes',name:'Refreshed Workspace Hermes',avatar:backendAvatar.id,sync_id:sync.sync_id});
    return true;
  });
  await page.getByText('Updated from the backend.', {exact:true}).waitFor();
  assert.equal(await agent.inputValue(), 'Refreshed Workspace Hermes');
  assert.equal(await owner.inputValue(), 'Mara');
  await shot('settings-profile', '.pane-scroll, .settings-profile');
  const sourceCategory = origin + '/#channel/' + sourceId;
  const threadHash = new URL(thread).hash;
  const categoryRow = page.locator(`.category-threads a[href="${threadHash}"]`);
  const categoryFeed = page.locator('.pane-scroll[data-category]');
  await page.goto(sourceCategory);
  await categoryRow.waitFor();
  const sourceScroll = await categoryFeed.evaluate(el => { el.scrollTop = 24; return el.scrollTop; });
  assert(sourceScroll > 0);
  await categoryRow.click();
  await page.locator('.assistant-turn .speaker').getByText('Refreshed Workspace Hermes', {exact:true}).first().waitFor();
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
  await destination.selectOption(destinationId);
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
  await page.goto(origin + '/#channel/' + destinationId);
  await page.locator('.category-threads a[href="' + new URL(thread).hash + '"]').waitFor();
  await page.locator('.category-threads a[href="' + new URL(thread).hash + '"]').click();
  await reply.getByRole('textbox').fill('');
  await reply.locator('input[type=file]').setInputFiles(wave);
  await tray.getByText('Audio', {exact:true}).waitFor();
  await reply.getByRole('textbox').press('Enter');
  await page.locator('.turn').nth(1).getByText('sample.wav', {exact:true}).waitFor();
  const appended = (await pages({type:'history',chat:original})).find((item) => !item.text && item.id !== original);
  assert(appended && appended.attachments.length === 1);
  await complete(appended.id, 'The attachments reached the gateway.', undefined, original);
  await page.getByText('The attachments reached the gateway.', {exact:true}).nth(1).waitFor();
  assert.equal(await page.locator('.turn').last().locator('.push-tag').count(), 0);

}

async function navigation(page, origin, hash, fixture) {
  const heading = page.getByRole('heading', {name:'Mobile composer coverage',exact:true});
  const assertThreadOnly = async () => {
    await heading.waitFor();
    assert.equal(await page.locator('.category-pane').count(), 0);
    assert.equal(await page.locator('#create').count(), 0);
    assert.equal(await page.locator('#compose').count(), 1);
  };
  await page.goto(`${origin}/#channel/general`);
  const row = page.locator(`.category-threads a[href="${hash}"]`);
  await row.click();
  await assertThreadOnly();
  await page.goBack();
  await row.waitFor();
  await page.waitForFunction(hash => document.activeElement?.getAttribute('href') === hash, hash);

  await page.getByRole('button', {name:'Find threads or categories'}).click();
  const search = page.getByRole('dialog', {name:'Find threads or categories'});
  const filter = search.getByRole('textbox');
  await filter.fill('Mobile composer coverage');
  const match = search.getByRole('link', {name:/Mobile composer coverage/});
  await match.waitFor();
  await filter.press('ArrowDown');
  assert(await match.evaluate(el => document.activeElement === el));
  await match.press('Enter');
  await assertThreadOnly();
  await page.setViewportSize({width:375,height:760});
  await page.getByRole('link', {name:'Back to General'}).click();
  await page.getByRole('button', {name:'Workspace',exact:true}).click();
  const drawer = page.getByRole('dialog', {name:'Workspace navigation'});
  await drawer.getByRole('button', {name:'Collapse General'}).click();
  assert.equal(await drawer.locator(`a[href="${hash}"]`).count(), 0);
  await drawer.getByRole('button', {name:'Expand General'}).click();
  await themeScreens(page, 'regression-drawer', [['.nav-drawer .workspace-brand'], ['.nav-drawer .nav-heading']]);
  await drawer.locator(`a[href="${hash}"]`).click();
  await drawer.waitFor({state:'hidden'});
  await assertThreadOnly();
  await assertLayout(page, 375, 760, '.conversation, #compose, #turns');
  const pushId = randomUUID();
  await page.goto(`${origin}/#inbox`);
  await fixture.post('push', {id:pushId,chat:hash.slice(1),text:'Read after opening the thread from Inbox.'});
  const notice = page.locator(`.inbox-pane a[href="${hash}"]`).filter({hasText:'Read after opening the thread from Inbox.'});
  await notice.waitFor();
  assert.equal((await fixture.pages({type:'inbox'})).find(item => item.request === pushId).unread, true);
  await notice.click();
  await assertThreadOnly();
  await fixture.eventually(async () => (await fixture.pages({type:'inbox'})).find(item => item.request === pushId)?.unread === false);
}

module.exports = async function workspaceBrowserRegressions(page, origin, fixture) {
  await page.goto(`${origin}/#inbox`);
  await assertGlobalPane(page, 'Inbox');
  await page.goto(`${origin}/#settings`);
  await assertGlobalPane(page, 'Settings');
  await page.goto(`${origin}/#channel/general`);
  await exerciseSlashMenu(page, page.locator('#create'), false, fixture);
  console.log('Desktop slash commands, keyboard, paste and Chrome IME passed');
  const failures = [];
  const check = async (name, test) => {
    try { await test(); console.log(`${name} passed`); }
    catch (error) { console.error(error); failures.push(name); }
  };
  await check('Archive, Inbox previews and generic browser alerts', () => require('./browser-archive.cjs')(page, origin, assertLayout, fixture));
  await page.setViewportSize({width:1100,height:800});
  await page.goto(`${origin}/#channel/general`);
  await check('Profile sync, byte-for-byte media, thread moves, and back focus', () => profilesAttachmentsAndMoves(page, origin, fixture));
  await page.goto(`${origin}/#channel/general`);
  const composer = page.locator('#create [contenteditable=true]');
  await composer.fill('Mobile composer coverage');
  await composer.press('Enter');
  await page.getByRole('heading', {name:'Mobile composer coverage',exact:true}).waitFor();
  const hash = new URL(page.url()).hash;
  await fixture.complete(hash.slice(1), 'Mobile fixture delivered');
  await exerciseSlashMenu(page, page.locator('#compose'), true, fixture, hash);
  await navigation(page, origin, hash, fixture);
  const box = page.locator('#compose [contenteditable=true]');
  const before = await fixture.pages({type:'history',chat:hash.slice(1)});
  await editorPaste(box, 'a'.repeat(8001));
  await page.locator('#compose').getByRole('alert').waitFor();
  assert.equal(await box.getAttribute('aria-invalid'), 'true');
  await box.press('Enter');
  assert.deepEqual(await fixture.pages({type:'history',chat:hash.slice(1)}), before);
  await box.fill('ab');
  await box.evaluate(el => window.getSelection().collapse(el.querySelector('p').firstChild, 1));
  await page.keyboard.press('Control+Enter');
  await page.keyboard.type('c');
  await box.press('Shift+Enter');
  await page.keyboard.type('d');
  assert.equal(await editorText(box), 'a\nc\ndb');
  await box.press('Enter');
  const saved = await fixture.eventually(async () => (await fixture.pages({type:'history',chat:hash.slice(1)})).find(row => row.state === 'queued'));
  assert.equal(saved.text, 'a  \nc  \ndb');
  await fixture.complete(saved.id, 'Composer line breaks delivered', undefined, hash.slice(1));
  console.log('Mobile touch, drawer, search, Inbox receipts, and durable composer Markdown passed');
  assert.deepEqual(failures, [], 'Browser regression groups that failed');
};
