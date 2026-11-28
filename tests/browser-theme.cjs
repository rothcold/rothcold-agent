const assert = require('node:assert/strict');
const path = require('node:path');

const canvas = {light:'rgb(246, 244, 238)', dark:'rgb(25, 33, 39)'};

async function assertTheme(page, choice, effective) {
  const appearance = await page.locator('html').evaluate(el => {
    const {backgroundColor, colorScheme} = getComputedStyle(el);
    return [el.dataset.theme, backgroundColor, colorScheme];
  });
  assert.deepEqual(appearance, [choice === 'system' ? undefined : choice, canvas[effective], choice === 'system' ? 'light dark' : choice]);
}

async function assertThemeFirstPaint(page, navigate, choice, effective) {
  let release;
  const app = new Promise(resolve => { release = resolve; });
  const holdApp = async route => { await app; await route.continue(); };
  await page.route('**/app.js', holdApp);
  try {
    const response = await navigate({waitUntil:'commit'});
    assert.match(response.headers()['content-security-policy'], /(?:^|;\s*)script-src 'self';/);
    await page.waitForFunction(() => performance.getEntriesByName('first-paint').length > 0);
    assert.equal(await page.locator('#root').textContent(), '', 'The application must not render before the paint check');
    await assertTheme(page, choice, effective);
  } finally {
    release();
    await page.waitForLoadState();
    await page.unroute('**/app.js', holdApp);
  }
}

async function assertContrast(page, checks) {
  const failures = await page.evaluate(checks => {
    function background(el) {
      for (; el; el = el.parentElement) {
        const color = getComputedStyle(el).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)') return color;
      }
      throw new Error('Missing opaque background');
    }
    function luminance(color) {
      const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color)?.slice(1);
      if (!channels) throw new Error(`Expected an opaque RGB color, got ${color}`);
      return channels.reduce((sum, channel, i) => {
        const s = Number(channel) / 255;
        return sum + [0.2126, 0.7152, 0.0722][i] * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
      }, 0);
    }
    return checks.flatMap(([selector, property = 'color', against = 'self', pseudo]) => {
      const el = [...document.querySelectorAll(selector)].find(el => el.getClientRects().length);
      if (!el) return [`${selector}: missing visible element`];
      const fg = getComputedStyle(el, pseudo).getPropertyValue(property);
      if (property === 'outline-color' && getComputedStyle(el).outlineStyle !== 'solid') return [`${selector}: missing focus outline`];
      const bg = background(against === 'parent' ? el.parentElement : el);
      const [low, high] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
      const ratio = (high + 0.05) / (low + 0.05);
      const threshold = property === 'color' ? 4.5 : 3;
      return ratio >= threshold ? [] : [`${selector} ${property}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (< ${threshold}:1)`];
    });
  }, checks);
  assert.deepEqual(failures, []);
}

async function themeScreens(page, surface, checks) {
  try {
    for (const theme of ['light','dark']) {
      await page.emulateMedia({colorScheme:theme});
      await assertTheme(page, 'system', theme);
      await assertContrast(page, checks);
      if (process.env.SHOTS) {
        const {width} = page.viewportSize();
        await page.screenshot({path:path.join(process.env.SHOTS, `theme-${theme}-${surface}-${width}.png`)});
      }
    }
  } finally {
    await page.emulateMedia({colorScheme:'dark'});
  }
}

async function checkAppearanceSettings(page, origin, connect = gate => gate.getByRole('button',{name:'Connect',exact:true}).click()) {
  const select = page.getByLabel('Theme', {exact:true});
  await select.waitFor();
  assert.equal(await select.inputValue(), 'system');
  await assertTheme(page, 'system', 'dark');
  await page.emulateMedia({colorScheme:'light'});
  await assertTheme(page, 'system', 'light');
  await select.selectOption('dark');
  await assertTheme(page, 'dark', 'dark');
  await page.emulateMedia({colorScheme:'dark'});
  await page.emulateMedia({colorScheme:'light'});
  await assertTheme(page, 'dark', 'dark');
  await assertThemeFirstPaint(page, options => page.reload(options), 'dark', 'dark');
  assert.equal(await select.inputValue(), 'dark');
  await page.emulateMedia({colorScheme:'dark'});
  await select.selectOption('light');
  await assertTheme(page, 'light', 'light');
  await page.emulateMedia({colorScheme:'light'});
  await page.emulateMedia({colorScheme:'dark'});
  await assertTheme(page, 'light', 'light');
  await assertThemeFirstPaint(page, options => page.reload(options), 'light', 'light');
  assert.equal(await select.inputValue(), 'light');

  const {origins} = await page.context().storageState();
  const {localStorage} = origins.find(entry => entry.origin === origin);
  const anonymous = await page.context().browser().newContext({
    viewport:{width:1100,height:800}, colorScheme:'dark', serviceWorkers:'block',
    storageState:{origins:[{origin,localStorage:localStorage.filter(item => item.name === 'rothcold-theme')}],cookies:[]},
  });
  try {
    const gate = await anonymous.newPage();
    await anonymous.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await assertThemeFirstPaint(gate, options => gate.goto(origin, options), 'light', 'light');
    await connect(gate);
    await gate.getByLabel('Owner token').waitFor();
    await assertTheme(gate, 'light', 'light');
    await gate.evaluate(() => localStorage.removeItem('rothcold-theme'));
    await gate.emulateMedia({colorScheme:'light'});
    await assertThemeFirstPaint(gate, options => gate.reload(options), 'system', 'light');
    await gate.getByLabel('Owner token').waitFor();
    for (const width of [1100,375]) {
      await gate.setViewportSize({width,height:800});
      await themeScreens(gate, 'login', [['#gate h1'], ['#gate label'], ['#gate input','border-top-color','parent'], ['#gate .primary-action']]);
    }
  } finally {
    await anonymous.close();
  }

  await select.selectOption('system');
  await assertTheme(page, 'system', 'dark');
  await page.emulateMedia({colorScheme:'light'});
  await assertTheme(page, 'system', 'light');
  await assertThemeFirstPaint(page, options => page.reload(options), 'system', 'light');
  assert.equal(await select.inputValue(), 'system');
  for (const width of [1100,375]) {
    await page.setViewportSize({width,height:800});
    await page.keyboard.press('Tab');
    await select.focus();
    await themeScreens(page, 'settings', [
      ['.command-settings'], ['.settings-appearance label'], ['.settings-appearance select'],
      ['.settings-appearance select','border-top-color','parent'], ['.settings-appearance select','outline-color','parent'],
    ]);
  }
  await page.setViewportSize({width:1100,height:800});
}

module.exports = { checkAppearanceSettings, themeScreens };
