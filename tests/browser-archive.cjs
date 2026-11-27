const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

module.exports = async function workspaceArchive(page, origin, assertLayout) {
  const sidebar = page.getByRole('complementary', {name:'Workspace navigation'});
  const categoryPane = page.locator('.category-pane');
  const breadcrumb = page.getByRole('navigation', {name:'Breadcrumb'});
  const archive = page.locator('.archive-pane');
  const inbox = page.locator('.inbox-pane');
  async function shot(view, width, height, containers) {
    await assertLayout(page, width, height, containers);
    if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS, `${view}-${width}x${height}.png`)});
  }
  async function categoryAction(name) {
    const menu = categoryPane.locator('.category-menu');
    await menu.locator('summary').click();
    await menu.getByRole('button', {name, exact:true}).click();
  }
  async function start(name) {
    const editor = page.locator('#first-message');
    await editor.fill(name);
    await editor.press('Enter');
    await page.getByRole('heading', {name, exact:true}).waitFor();
    return new URL(page.url()).hash;
  }

  await sidebar.getByText('New category', {exact:true}).click();
  await sidebar.getByLabel('Category name').fill('Archive fixtures');
  await sidebar.getByRole('button', {name:'Create category'}).click();
  await categoryPane.getByRole('heading', {name:'Archive fixtures', exact:true}).waitFor();
  const categoryHash = new URL(page.url()).hash;
  const parked = await start('Park this thread');
  await page.getByText('First archive reply', {exact:true}).waitFor();
  const reply = page.locator('#text');
  await reply.fill('Reply again');
  await reply.press('Enter');
  await page.getByText('Second archive reply', {exact:true}).waitFor();
  await reply.fill('Draft survives thread archive');
  await page.getByRole('button', {name:'Archive thread', exact:true}).click();
  await page.getByText('Restore this thread to reply.', {exact:true}).waitFor();
  assert.equal(await reply.count(), 0);
  assert.equal(await sidebar.locator(`a[href="${parked}"]`).count(), 0);

  await page.getByRole('link', {name:'Back to Archive fixtures'}).click();
  await categoryPane.getByRole('heading', {name:'Archive fixtures'}).waitFor();
  const kept = await start('Keep this thread');
  await page.getByRole('link', {name:'Back to Archive fixtures'}).click();
  await page.locator('#first-message').fill('Draft survives category rename and archive');
  const menu = categoryPane.locator('.category-menu');
  await menu.locator('summary').click();
  await menu.getByLabel('Rename category to').fill('Renamed fixtures');
  await menu.getByRole('button', {name:'Rename category', exact:true}).click();
  await breadcrumb.getByText('Renamed fixtures', {exact:true}).waitFor();
  await sidebar.getByRole('link', {name:'Renamed fixtures', exact:true}).waitFor();
  assert.equal(new URL(page.url()).hash, categoryHash);
  assert.equal(await page.locator('#first-message').innerText(), 'Draft survives category rename and archive');
  await categoryAction('Archive category');
  await page.getByText('Restore this category to start a thread.', {exact:true}).waitFor();
  assert.equal(await sidebar.getByRole('link', {name:'Renamed fixtures', exact:true}).count(), 0);
  assert.equal(await page.locator('#first-message').count(), 0);
  await shot('archived-category', 1100, 800, '.category-pane, .pane-scroll');
  await page.setViewportSize({width:390, height:844});
  await menu.locator('summary').click();
  await assertLayout(page, 390, 844, '.category-pane, .pane-scroll', '.category-menu summary, .category-menu button');
  await shot('archived-category-actions', 390, 844, '.category-pane, .pane-scroll');
  await menu.locator('summary').click();
  await page.setViewportSize({width:1100, height:800});

  await page.getByRole('button', {name:'Find threads or categories'}).click();
  const search = page.getByRole('dialog', {name:'Find threads or categories'});
  for (const text of ['fixtures', 'Park this thread', 'Keep this thread']) {
    await search.getByRole('textbox').fill(text);
    assert.equal(await search.getByRole('link').count(), 0);
  }
  await search.getByRole('button', {name:'Cancel search'}).click();
  await sidebar.getByRole('link', {name:'Archived', exact:true}).click();
  await archive.getByRole('heading', {name:'Archived', exact:true}).waitFor();
  await archive.getByRole('link', {name:'Renamed fixtures', exact:true}).waitFor();
  await archive.getByRole('link', {name:/Keep this thread.*Category archived/}).waitFor();
  await archive.getByRole('link', {name:/Park this thread.*Thread archived/}).waitFor();
  await shot('workspace-archive', 1100, 800, '.archive-pane, .pane-scroll');
  await shot('workspace-archive', 390, 844, '.archive-pane, .pane-scroll');
  await archive.getByRole('link', {name:/Park this thread.*Thread archived/}).click();
  await page.getByText('Restore the category and this thread to reply.', {exact:true}).waitFor();
  await shot('archived-thread', 390, 844, '.conversation, #turns');

  await page.goto(`${origin}/#inbox`);
  await inbox.getByText('Second archive reply', {exact:true}).waitFor();
  const sameThread = inbox.locator(`a[href="${parked}"]`);
  assert.deepEqual(await sameThread.locator('.inbox-preview').allTextContents(), ['Second archive reply', 'First archive reply']);
  assert.deepEqual(await sameThread.locator('.inbox-thread-title').allTextContents(), ['Park this thread', 'Park this thread']);
  await inbox.getByText('Fixture delivered', {exact:true}).waitFor();
  const observing = page.waitForResponse(r => r.url().endsWith('/api/notifications') && r.ok());
  await inbox.getByRole('button', {name:'Enable browser alerts'}).click();
  await inbox.getByRole('button', {name:'Turn off browser alerts'}).waitFor();
  await observing;
  const apiOrigin = 'http://127.0.0.1:8766';
  const longText = '工作区'.repeat(46) + '👩🏽‍🚀🌈';
  const pushId = randomUUID();
  const pushed = await fetch(apiOrigin + '/adapter/push', {
    method:'POST',
    headers:{Origin:apiOrigin, Authorization:'Bearer ' + process.env.ROTHCOLD_AGENT_ADAPTER_TOKEN, 'Content-Type':'application/json'},
    body:JSON.stringify({id:pushId, chat:kept.slice(1), text:`**${longText}** [private](https://example.invalid/path)`})
  });
  assert.equal(pushed.status, 200);
  const pushPreview = inbox.getByText(longText + '…', {exact:true});
  await pushPreview.waitFor();
  assert.equal(await inbox.locator('.inbox-preview a').count(), 0);
  const tag = `rothcold:${pushId}`;
  await page.waitForFunction((tag) => window.sentAlerts.some(n => n.tag === tag), tag);
  assert.deepEqual(await page.evaluate((tag) => window.sentAlerts.filter(n => n.tag === tag).map(n => [n.title, n.body]), tag),
                   [['Rothcold Agent', 'You have a new message.']]);
  await shot('inbox-preview', 390, 844, '.inbox-pane, .pane-scroll');
  await shot('inbox-preview', 1100, 800, '.inbox-pane, .pane-scroll');
  await sameThread.first().click();
  await page.getByText('Restore the category and this thread to reply.', {exact:true}).waitFor();
  await page.getByRole('link', {name:'Back to Renamed fixtures'}).click();
  await categoryAction('Restore category');
  await page.locator('#first-message').waitFor();
  assert.equal(await page.locator('#first-message').innerText(), 'Draft survives category rename and archive');
  await categoryPane.locator(`a[href="${kept}"]`).getByText('Keep this thread', {exact:true}).waitFor();
  assert.equal(await categoryPane.locator(`a[href="${parked}"]`).count(), 0);
  await page.evaluate((hash) => { window.location.hash = hash; }, parked);
  await page.getByText('Restore this thread to reply.', {exact:true}).waitFor();
  await page.getByRole('button', {name:'Restore thread', exact:true}).click();
  await reply.waitFor();
  assert.equal(await reply.innerText(), 'Draft survives thread archive');
  await page.reload();
  await reply.waitFor();
  assert.equal(new URL(page.url()).hash, parked);
  await page.setViewportSize({width:390, height:844});
  await page.getByRole('button', {name:'Workspace', exact:true}).click();
  await sidebar.getByRole('link', {name:'Archived', exact:true}).click();
  await archive.getByText('No archived threads.', {exact:true}).waitFor();
};
