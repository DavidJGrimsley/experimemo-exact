// Camera capture in a real Chromium: Chrome's own fake capture device (a generated test pattern, not a
// physical camera) behind the real @exact/media-capture and @exact/camera web implementations.
// Denied, missing and unsupported cameras are Chromium's own refusal or a page-level mock (stated per check).
//
//   bun exact.mjs web-build      # builds target/web-dist
//   CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" bun camera-web.test.mjs
//
// Not covered: a physical camera, iOS, Android, Firefox, Safari.
import { extname, join, resolve } from 'node:path';

const exactRoot = resolve(import.meta.dir, process.env.EXACT2 ?? '../../../temp/exact-upstream');
const { chromium } = await import(resolve(exactRoot, 'node_modules/playwright-core/index.mjs'));
const dist = join(import.meta.dir, 'target/web-dist');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png' };
const server = Bun.serve({ port: 0, async fetch(req) {
  let path = new URL(req.url).pathname;
  if (path === '/') path = '/index.html';
  let file = Bun.file(join(dist, path));
  // a deep link (a reload on /experiment/:id) is the app's own route: serve the page
  if (!(await file.exists())) { path = '/index.html'; file = Bun.file(join(dist, path)); }
  return new Response(file, { headers: { 'content-type': types[extname(path)] ?? 'application/octet-stream' } });
} });
const origin = `http://127.0.0.1:${server.port}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
};

// Counts camera opens and browser tracks stopped, so a closed sheet is shown to release the device.
const count = () => {
  const gum = MediaDevices.prototype.getUserMedia, stop = MediaStreamTrack.prototype.stop;
  globalThis.__media = { opens: 0, stops: 0 };
  MediaDevices.prototype.getUserMedia = function (...a) { globalThis.__media.opens++; return gum.apply(this, a); };
  MediaStreamTrack.prototype.stop = function () { if (this.readyState === 'live') globalThis.__media.stops++; return stop.call(this); };
};
const notFound = () => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('mock', 'NotFoundError'));
};
const noMediaDevices = () => {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
};
// A shot that takes as long as the test says: with __holdNext set, the next ImageCapture.takePhoto waits for
// __releaseShot() and then succeeds with a generated frame (so a track stopped meanwhile cannot fail it).
const holdShots = () => {
  const real = ImageCapture.prototype.takePhoto;
  ImageCapture.prototype.takePhoto = async function (...a) {
    if (!globalThis.__holdNext) return real.apply(this, a);
    globalThis.__holdNext = false;
    await new Promise((release) => { globalThis.__releaseShot = release; globalThis.__shotHeld = true; });
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
    c.getContext('2d').fillRect(0, 0, 64, 48);
    return new Promise((done, fail) => c.toBlob((b) => (b ? done(b) : fail(new Error('no frame'))), 'image/jpeg', 0.9));
  };
};
// The app's files whose path holds `part`, read from the web host's IndexedDB file store.
const storedFiles = (page, part) => page.evaluate(async (part) => {
  const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const out = [];
  for (const d of (await indexedDB.databases()).filter((d) => d.name?.startsWith('exact-storage:'))) {
    const db = await req(indexedDB.open(d.name));
    if (db.objectStoreNames.contains('files')) out.push(...(await req(db.transaction('files').objectStore('files').getAllKeys())).map(String).filter((k) => k.includes(part)));
    db.close();
  }
  return out;
}, part);
const noCameraTemps = (page) => page.waitForFunction(async () => {
  const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  for (const d of (await indexedDB.databases()).filter((d) => d.name?.startsWith('exact-storage:'))) {
    const db = await req(indexedDB.open(d.name));
    const keys = db.objectStoreNames.contains('files') ? await req(db.transaction('files').objectStore('files').getAllKeys()) : [];
    db.close();
    if (keys.some((k) => String(k).includes('/tmp/camera/'))) return false;
  }
  return true;
}, null, { timeout: 10000, polling: 250 }).then(() => true, () => false);

const executablePath = process.env.CHROME;
const fake = ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];

async function open(browser, { init, args } = {}) {
  const context = await browser.newContext({ viewport: { width: 700, height: 900 } });
  await context.addInitScript(count);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  globalThis.__page = page;
  await page.goto(origin);
  await page.getByTestId('field-title').waitFor();
  return { context, page };
}
const photos = (page) => page.locator('[data-testid^="photo-photo-"]').count();
const media = (page) => page.evaluate(() => globalThis.__media);
const text = (page, id) => page.getByTestId(id).innerText({ timeout: 10000 });
const sees = async (page, id, ms = 10000) => page.getByTestId(id).waitFor({ timeout: ms }).then(() => true, () => false);
const gone = async (page, id, ms = 10000) => page.getByTestId(id).waitFor({ state: 'detached', timeout: ms }).then(() => true, () => false);
// The fake device now and then fails ImageCapture.takePhoto (UnknownError); the app then shows the error and
// keeps the sheet open, so a person presses the shutter again. Do the same, and say it happened.
let retries = 0;
const shoot = async (page) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByTestId('camera-shutter').click();
    const outcome = await Promise.race([
      gone(page, 'viewfinder', 15000).then((g) => (g ? 'closed' : 'open')),
      sees(page, 'camera-shot-error', 15000).then((e) => (e ? 'error' : 'open')),
    ]);
    if (outcome === 'closed') return;
    retries++;
    console.log(`note: shutter attempt ${attempt + 1} refused by the fake device: ${await text(page, 'camera-shot-error').catch(() => '')}`);
  }
};
const settle = (page) => page.waitForTimeout(600);
const goTrackCard = async (page, title) => {
  await page.getByTestId('tab-track').or(page.getByRole('button', { name: 'Track' })).first().click();
  await page.getByText(title).first().click();
  await page.getByTestId('editor-title').waitFor();
};

const browser = await chromium.launch({ executablePath, headless: true, args: [...fake, '--use-fake-ui-for-media-stream'] });
const denyBrowser = await chromium.launch({ executablePath, headless: true, args: [...fake, '--deny-permission-prompts'] });
try {
  // --- granted, Chrome's fake capture device ---
  {
    const { context, page } = await open(browser);
    await page.getByTestId('new-add-photos').click();
    check('the chooser names Take Photo, Choose from Library and Cancel',
      await sees(page, 'photo-source-text') && (await text(page, 'photo-source-text')) === 'Choose how to add experiment photos.'
      && (await text(page, 'photo-source-camera')) === 'Take Photo' && (await text(page, 'photo-source-library')) === 'Choose from Library'
      && (await text(page, 'photo-source-cancel')) === 'Cancel');
    await page.getByTestId('photo-source-cancel').click();
    await settle(page);
    check('Cancel in the chooser adds nothing and opens no camera', (await photos(page)) === 0 && (await media(page)).opens === 0);

    await page.getByTestId('new-add-photos').click();
    await page.getByTestId('photo-source-camera').click();
    check('Take Photo opens a viewfinder playing the fake camera', await sees(page, 'viewfinder'));
    const playing = await page.waitForFunction(() => { const v = document.querySelector('[data-testid="viewfinder"] video'); return v && v.videoWidth > 0 && !!v.srcObject; }, null, { timeout: 10000 }).then(() => true, () => false);
    check('the viewfinder video has frames', playing);
    await shoot(page);
    check('the shot is staged on New and the sheet closes', await gone(page, 'viewfinder') && await page.waitForFunction(() => document.querySelectorAll('[data-testid^="photo-photo-"]').length === 1, null, { timeout: 15000 }).then(() => true, () => false));
    const m1 = await media(page);
    check('the camera is released after the shot', m1.stops >= 1, JSON.stringify(m1));
    const thumb = await page.waitForFunction(() => { const i = document.querySelector('[data-testid^="photo-photo-"] img'); return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 10000 }).then(() => true, () => false);
    check('the staged photo renders from durable storage', thumb);

    await page.getByTestId('field-title').fill('Camera test');
    await page.getByTestId('field-hypothesis').fill('A shot is kept.');
    await page.getByTestId('field-procedure').fill('Take a photo, save, reload.');
    await page.getByTestId('save').click();
    await page.getByTestId('editor-title').or(page.getByTestId('tab-track')).first().waitFor();
    await goTrackCard(page, 'Camera test');
    check('the saved experiment carries the camera photo', await page.waitForFunction(() => document.querySelectorAll('[data-testid^="photos-exp"] [data-testid^="photo-photo-"]').length === 1, null, { timeout: 10000 }).then(() => true, () => false));

    // second photo attached straight to the stored experiment
    await page.getByTestId('exp-add-photos').click();
    await page.getByTestId('photo-source-camera').click();
    await sees(page, 'viewfinder');
    await shoot(page);
    const attachedOk = await page.waitForFunction(() => document.querySelectorAll('[data-testid="photos-exp"] [data-testid^="photo-photo-"]').length === 2, null, { timeout: 15000 }).then(() => true, () => false);
    check('a camera photo attaches at once to a stored experiment', attachedOk,
      await page.evaluate(() => [...document.querySelectorAll('[data-testid="exp-photo-note"],[data-testid="camera-shot-error"],[data-testid="camera-error"],[data-testid="viewfinder"]')].map((e) => `${e.dataset.testid}:${e.innerText}`).join(' | ')));

    // a result draft, then saved
    await page.getByTestId('draft-add-photos').click();
    await page.getByTestId('photo-source-camera').click();
    await sees(page, 'viewfinder');
    await shoot(page);
    await gone(page, 'viewfinder');
    check('a camera photo joins the result draft (not the experiment)', await page.waitForFunction(() => document.querySelectorAll('[data-testid="photos-draft"] [data-testid^="photo-photo-"]').length === 1 && document.querySelectorAll('[data-testid="photos-exp"] [data-testid^="photo-photo-"]').length === 2, null, { timeout: 15000 }).then(() => true, () => false));
    await page.getByTestId('result-add').click();
    check('Save result stores the camera photo with the result', await page.waitForFunction(() => /1 photo attached/.test(document.body.innerText), null, { timeout: 10000 }).then(() => true, () => false));

    // cancelling the camera
    const before = await media(page);
    await page.getByTestId('exp-add-photos').click();
    await page.getByTestId('photo-source-camera').click();
    await sees(page, 'viewfinder');
    await page.getByTestId('camera-close').click();
    await gone(page, 'viewfinder');
    const after = await media(page);
    check('closing the camera adds nothing, says so, and releases the device',
      (await text(page, 'exp-photo-note')) === 'Photo capture cancelled. Nothing was changed.' && (await page.locator('[data-testid="photos-exp"] [data-testid^="photo-photo-"]').count()) === 2 && after.stops > before.stops,
      `${JSON.stringify(before)} ${JSON.stringify(after)}`);

    await page.reload();
    await page.getByTestId('editor-title').waitFor();
    check('both experiment photos and the result photo survive a reload',
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="photos-exp"] [data-testid^="photo-photo-"]').length === 2 && /1 photo attached/.test(document.body.innerText), null, { timeout: 10000 }).then(() => true, () => false));
    await context.close();
  }

  // --- a shot that lands after its sheet closed is thrown away (held ImageCapture.takePhoto, mocked) ---
  {
    const { context, page } = await open(browser, { init: `(${holdShots.toString()})()` });
    const expPhotos = () => page.locator('[data-testid="photos-exp"] [data-testid^="photo-photo-"]').count();
    const ready = () => page.waitForFunction(() => { const v = document.querySelector('[data-testid="viewfinder"] video'); return v && v.videoWidth > 0 && !!v.srcObject; }, null, { timeout: 10000 }).then(() => true, () => false);
    const holdAndClose = async () => {
      await page.evaluate(() => { globalThis.__holdNext = true; globalThis.__shotHeld = false; });
      await page.getByTestId('exp-add-photos').click();
      await page.getByTestId('photo-source-camera').click();
      await sees(page, 'viewfinder');
      await ready();
      await page.getByTestId('camera-shutter').click();
      await page.waitForFunction(() => globalThis.__shotHeld === true, null, { timeout: 10000 });
      await page.getByTestId('camera-close').click();
      await gone(page, 'viewfinder');
    };

    // closed, then the shot lands
    await goTrackCard(page, 'Bean sprouts');
    const sprouts = await expPhotos();
    await holdAndClose();
    await page.evaluate(() => globalThis.__releaseShot());
    const cleaned = await noCameraTemps(page);
    await settle(page);
    check('a shot that lands after the camera closed attaches nothing and keeps the cancel note',
      (await expPhotos()) === sprouts && (await text(page, 'exp-photo-note')) === 'Photo capture cancelled. Nothing was changed.' && !(await sees(page, 'viewfinder', 500)),
      `${await expPhotos()} photos, was ${sprouts}`);
    check('the late shot\'s temporary file is removed', cleaned, JSON.stringify(await storedFiles(page, '/tmp/camera/')));

    // closed, the camera opened again for another record, then the first shot lands
    await holdAndClose();
    await page.goBack();
    await page.getByTestId('card-experiment-seed-2').click();
    await page.getByTestId('editor-title').waitFor();
    const cooling = await expPhotos();
    await page.getByTestId('exp-add-photos').click();
    await page.getByTestId('photo-source-camera').click();
    await sees(page, 'viewfinder');
    const reopened = await ready();
    await page.evaluate(() => globalThis.__releaseShot());
    const cleanedAgain = await noCameraTemps(page);
    await settle(page);
    check('a late shot from the first record is not attached to the record the camera reopened for',
      reopened && (await expPhotos()) === cooling, `${await expPhotos()} photos, was ${cooling}`);
    check('the late shot leaves the reopened camera open and live',
      (await sees(page, 'viewfinder', 500)) && await ready(), await page.evaluate(() => document.body.innerText.slice(0, 200)));
    check('the late shot\'s temporary file is removed while the new camera is open', cleanedAgain, JSON.stringify(await storedFiles(page, '/tmp/camera/')));
    await shoot(page);
    check('the reopened camera\'s own shot attaches to its own record',
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="photos-exp"] [data-testid^="photo-photo-"]').length === n + 1, cooling, { timeout: 15000 }).then(() => true, () => false));
    check('after its own shot no camera temporary file is left', await noCameraTemps(page), JSON.stringify(await storedFiles(page, '/tmp/camera/')));

    await page.reload();
    await page.getByTestId('editor-title').waitFor();
    const coolingAfter = await page.waitForFunction((n) => document.querySelectorAll('[data-testid="photos-exp"] [data-testid^="photo-photo-"]').length === n + 1, cooling, { timeout: 10000 }).then(() => true, () => false);
    await page.goBack();
    await page.getByTestId('card-experiment-seed-1').click();
    await page.getByTestId('editor-title').waitFor();
    await settle(page);
    check('after a reload the first record still has none of the late shots and the second has only its own',
      coolingAfter && (await expPhotos()) === sprouts, `${await expPhotos()} photos, was ${sprouts}`);
    check('the durable photo store holds only the one kept photo', (await storedFiles(page, '/data/photos/')).filter((k) => !k.endsWith('/data/photos')).length === 1,
      JSON.stringify(await storedFiles(page, '/data/photos/')));
    await context.close();
  }

  // --- the browser refuses the camera (Chromium's own denial) ---
  {
    const { context, page } = await open(denyBrowser);
    await page.getByTestId('new-add-photos').click();
    await page.getByTestId('photo-source-camera').click();
    const denied = await sees(page, 'camera-error', 15000);
    const msg = denied ? await text(page, 'camera-error') : '';
    check('a denied camera is explained, with nothing added', denied && /denied/i.test(msg) && (await photos(page)) === 0, msg);
    await page.getByTestId('camera-close').click();
    await gone(page, 'camera-error');
    await context.close();
  }

  // --- page-level mocks of other refusals ---
  {
    const { context, page } = await open(browser, { init: `(${notFound.toString()})()` });
    await page.getByTestId('new-add-photos').click();
    await page.getByTestId('photo-source-camera').click();
    const shown = await sees(page, 'camera-error', 15000);
    const msg = shown ? await text(page, 'camera-error') : '';
    check('no camera found (NotFoundError, mocked) is explained', /No camera was found/.test(msg) && (await photos(page)) === 0, msg);
    await context.close();
  }
  {
    const { context, page } = await open(browser, { init: `(${noMediaDevices.toString()})()` });
    await page.getByTestId('new-add-photos').click();
    await page.getByTestId('photo-source-camera').click();
    const shown = await sees(page, 'new-photo-note', 15000);
    const msg = shown ? await text(page, 'new-photo-note') : '';
    check('a host with no camera API (mediaDevices removed, mocked) says so and opens no sheet',
      /camera is not available/i.test(msg) && !(await sees(page, 'viewfinder', 500)) && (await photos(page)) === 0, msg);
    await context.close();
  }
} catch (e) {
  failures++;
  const lines = String(e.stack).split('\n').filter((l) => l.includes('camera-web.test.mjs')).join('\n');
  console.log('FAIL unexpected: ' + String(e.message).split('\n')[0] + '\n' + lines);
  const page = globalThis.__page;
  if (page) console.log('DOM', await page.evaluate(() => [...document.querySelectorAll('[data-testid]')].filter((e) => /note|error|viewfinder|shutter|camera|source/.test(e.dataset.testid)).map((e) => `${e.dataset.testid}${e.disabled ? '(disabled)' : ''}:${e.innerText.slice(0, 60)}`).join(' | ')).catch(() => '(page gone)'));
} finally {
  await browser.close();
  await denyBrowser.close();
  server.stop();
}
console.log(`shutter retries: ${retries}`);
console.log(failures === 0 ? 'camera-web: all passed' : `camera-web: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
