const { chromium } = require(process.env.PLAYWRIGHT_DIR);
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM, args:[
    '--disable-background-networking','--disable-component-update','--no-first-run',
    '--proxy-server=http://127.0.0.1:1','--proxy-bypass-list=127.0.0.1',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
  ]});
  try {
    const origin = 'http://127.0.0.1:8766';
    const outsideOrigins = []; const errors = [];
    async function open(url, width) {
      const ctx = await browser.newContext({viewport:{width,height:800}, serviceWorkers:'block'});
      await ctx.route('**/*', route => {
        const target = new URL(route.request().url()).origin;
        if (target === origin) return route.continue();
        outsideOrigins.push(target);
        return route.abort();
      });
      const page = await ctx.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      assert.equal(await page.title(), 'rothcold-agent');
      await page.getByLabel('Owner token').fill(process.env.ROTHCOLD_AGENT_OWNER_TOKEN);
      await page.getByRole('button',{name:'Open workspace'}).click();
      return page;
    }
    const page = await open(origin,1100);
    await page.getByRole('heading',{name:'General'}).waitFor();
    if (process.argv.includes('--offline')) {
      for (const text of ['First offline message', 'Second offline message']) {
        await page.getByRole('textbox',{name:/Your message|New thread in/}).fill(text);
        await page.getByRole('button',{name:'Send message'}).click();
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
      await page.getByRole('button',{name:'Workspace',exact:true}).click();
      const drawer = page.getByRole('dialog',{name:'Workspace navigation'});
      await drawer.getByRole('button',{name:'Collapse General'}).click();
      assert.equal(await drawer.getByRole('link',{name:'First offline message'}).count(),0);
      await drawer.getByRole('button',{name:'Expand General'}).click();
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,'drawer-375.png')});
      await page.keyboard.press('Escape');
      assert(!(await drawer.isVisible()));
      await page.getByRole('button',{name:'Workspace',exact:true}).click();
      await drawer.getByRole('link',{name:'New thread'}).click();
      await page.getByLabel('New thread in General').fill('Another project');
      await page.getByRole('button',{name:'Send message'}).click();
      await page.getByRole('heading',{name:'Another project'}).waitFor();
      await page.setViewportSize({width:1100,height:800});
      await page.getByRole('navigation').getByRole('link',{name:'First offline message'}).click();
      await page.getByRole('heading',{name:'First offline message'}).waitFor();
      assert.equal(page.url(),first);
      assert.equal(await page.getByLabel('Your message').inputValue(),'Unsent reply');
      assert.deepEqual(outsideOrigins, []);
      assert.deepEqual(errors, []);
      return;
    }
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
    await page.getByRole('button',{name:'Send message'}).click();
    await page.getByText('Failed to fetch',{exact:true}).waitFor();
    await page.getByRole('link',{name:'General',exact:true}).click();
    await page.getByRole('heading',{name:'General'}).waitFor();
    await page.getByRole('link',{name:'Library',exact:true}).click();
    await page.getByRole('heading',{name:'Library'}).waitFor();
    for (const width of [1100,375]) {
      await page.setViewportSize({width,height:800});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,`channel-${width}.png`),fullPage:true});
    }
    assert.equal(await page.getByLabel('New thread in Library').inputValue(),'What should I read first?');
    await page.getByRole('button',{name:'Send message'}).click();
    await page.getByRole('heading',{name:'What should I read first?'}).waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    await page.getByText('Accepted by Hermes.',{exact:false}).waitFor();
    await page.getByText('📖 Reading src/main.rs',{exact:false}).waitFor();
    await page.locator('.interim-note strong',{hasText:'summary'}).waitFor();
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
    for (const width of [1100,375]) {
      await page.setViewportSize({width,height:800});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHOTS) await page.screenshot({path:path.join(process.env.SHOTS,`rename-${width}.png`),fullPage:true});
    }
    await title.press('Enter');
    await page.getByRole('heading',{name:'Library reading list'}).waitFor();
    assert.equal(page.url(),url);
    await page.getByRole('link',{name:'# Library',exact:true}).click();
    await page.getByRole('link',{name:'Library reading list'}).click();
    await page.context().close();
    console.log('closed'); // releases the test handler, not an HTTP control route
    for await (const signal of process.stdin) { assert.equal(signal.toString(), 'final\n'); break; }
    const fresh = await open(url,1100);
    await fresh.getByRole('heading',{name:'Library reading list'}).waitFor();
    await fresh.locator('.markdown h3',{hasText:'Reading plan'}).waitFor();
    await fresh.getByText('Start with <chapter one> and',{exact:false}).waitFor();
    await fresh.locator('.markdown strong',{hasText:'read'}).waitFor();
    await fresh.locator('.markdown code',{hasText:'Cargo.toml'}).waitFor();
    await fresh.locator('.markdown pre code',{hasText:'fn main() {}'}).waitFor();
    await fresh.locator('.markdown table td',{hasText:'ok'}).waitFor();
    assert.equal(await fresh.locator('chapter').count(), 0);
    await fresh.locator('.activity-details summary',{hasText:'Activity (2 updates)'}).waitFor();
    assert.equal(await fresh.locator('article').count(),1);
    await fresh.getByRole('link',{name:'Notifications 1 unread'}).waitFor();
    for (const width of [1100,375]) {
      await fresh.setViewportSize({width,height:800});
      assert(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,`${width}.png`),fullPage:true});
    }
    await fresh.getByRole('button',{name:'Workspace',exact:true}).click();
    const inbox = fresh.getByRole('link',{name:'Notifications 1 unread'});
    await inbox.click();
    const event = fresh.getByRole('link',{name:'Library · Unread Library reading list'});
    assert.equal(await event.getAttribute('href'),new URL(url).hash);
    for (const width of [1100,375]) {
      await fresh.setViewportSize({width,height:800});
      assert(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHOTS) await fresh.screenshot({path:path.join(process.env.SHOTS,`inbox-${width}.png`),fullPage:true});
    }
    await event.click();
    await fresh.getByRole('heading',{name:'Library reading list'}).waitFor();
    assert.equal(fresh.url(), url);
    await fresh.getByRole('button',{name:'Workspace',exact:true}).click();
    await fresh.getByRole('link',{name:'Notifications 0 unread'}).click();
    await fresh.getByRole('link',{name:'Library · Read Library reading list'}).waitFor();
    assert.deepEqual(outsideOrigins, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
