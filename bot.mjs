// Autoplayer for Bobble Run (https://unboxbobble.com/run) driven by the game's built-in demo AI.
//
// Guest mode (default): fresh profile, no wallet, every non-asset request is aborted — nothing is saved.
// Online mode (--online): persistent browser profile where you connect your wallet yourself; runs are
// played and submitted through the official game client (allowed by the BOBBLE team, Nov 2026).
// The bot never touches wallet keys: you sign in manually in the browser window.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const URL_RUN = 'https://unboxbobble.com/run';
const HOST = 'unboxbobble.com';
const STORAGE_KEY = 'bobble.run.v1';
const VERSION = 'v13';
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const ONLINE = 'online' in args;
const HEADLESS = ONLINE ? false : !('headed' in args);
const RUNS = Number(args.runs ?? (ONLINE ? 0 : 1)); // 0 = until Ctrl+C
// Game sessions need ~61 min of validity at start; release controls before a run gets too long to submit.
const MAX_RUN_MS = Number(args.maxRunMinutes ?? (ONLINE ? 50 : 0)) * 60_000;
const SHOT = args.screenshot;
console.log(`Bobble bot ${VERSION} (${ONLINE ? 'ONLINE: runs are saved to your wallet' : 'guest: nothing is saved'}), node ${process.version}, ${process.platform}`);

const blocked = new Set();
let patched = false;

function isStaticAsset(u) {
  return u.pathname === '/run' || u.pathname.startsWith('/v/') || /\.(woff2?|ttf|png|jpe?g|webp|svg|glb|gltf|ktx2|mp3|ogg|wav|css|ico)$/.test(u.pathname);
}

// Accepts scheme://host:port, scheme://user:pass@host:port, or scheme://host:port:user:pass.
function parseProxy(raw) {
  if (!raw || raw === true) return undefined;
  const m = /^(?:(\w+):\/\/)?([^:@/]+):(\d+):([^:]+):(.+)$/.exec(raw);
  if (m) return { server: `${m[1] || 'http'}://${m[2]}:${m[3]}`, username: m[4], password: m[5] };
  const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const p = { server: `${u.protocol}//${u.host}` };
  if (u.username) { p.username = decodeURIComponent(u.username); p.password = decodeURIComponent(u.password); }
  return p;
}
const PROXY = parseProxy(args.proxy || process.env.BOBBLE_PROXY);
if (PROXY) console.log(`Proxy: ${PROXY.server}${PROXY.username ? ' (with login)' : ''}`);

const launchArgs = ['--autoplay-policy=no-user-gesture-required', '--disable-quic'];
// Software WebGL only for GPU-less servers; on a desktop it can crash the browser.
if ('swiftshader' in args || (HEADLESS && process.platform === 'linux')) {
  launchArgs.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
}
const label = c => c || 'playwright chromium';
let browser = null;
let context;
if (ONLINE) {
  // Branded Chrome/Edge first: wallet extensions install from their stores there.
  const channels = args.channel ? [args.channel === 'chromium' ? undefined : args.channel] : ['chrome', 'msedge', undefined];
  const profileDir = path.resolve(args.profile || 'bobble-profile');
  for (const channel of channels) {
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: false, channel, args: launchArgs, proxy: PROXY, viewport: null,
        ignoreDefaultArgs: ['--disable-extensions', '--enable-automation', '--disable-component-extensions-with-background-pages'],
      });
      console.log(`Browser: ${label(channel)}, profile: ${profileDir}`);
      break;
    } catch (e) {
      console.warn(`Could not start ${label(channel)}: ${e.message.split('\n')[0]}`);
    }
  }
} else {
  const channels = args.channel ? [args.channel] : process.platform === 'win32' ? [undefined, 'msedge', 'chrome'] : [undefined, 'chrome'];
  for (const channel of channels) {
    try {
      browser = await chromium.launch({ headless: HEADLESS, args: launchArgs, channel, proxy: PROXY });
      console.log(`Browser: ${label(channel)}, ${HEADLESS ? 'hidden (add --headed to see it)' : 'window visible'}`);
      break;
    } catch (e) {
      console.warn(`Could not start ${label(channel)}: ${e.message.split('\n')[0]}`);
    }
  }
  if (browser) context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
}
if (!context) throw new Error('No browser could be started. Run: npx playwright install chromium');

let closing = false;
context.on('close', () => {
  if (closing) return;
  console.error('\nBrowser closed. Do not close the game window while the bot runs.');
  process.exit(1);
});

function cleanHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!/^(content-encoding|content-length|transfer-encoding|etag|last-modified)$/i.test(k)) out[k] = v;
  }
  return out;
}

// Some networks stall Chromium's own requests to Cloudflare while Node's work, so game traffic goes through Node.
async function fetchViaNode(route, req) {
  return route.fetch({ timeout: 180_000, maxRetries: req.method() === 'GET' ? 2 : 0, headers: { ...req.headers(), 'accept-encoding': 'identity' } });
}

// /v/<build-hash>/ assets are immutable, so a disk cache makes later launches fast on slow links.
const CACHE_DIR = path.resolve('bobble-cache');
function cachePath(u) {
  if (!u.pathname.startsWith('/v/') || u.search) return null;
  return path.join(CACHE_DIR, ...u.pathname.split('/').filter(Boolean));
}
async function readCache(u) {
  const p = cachePath(u);
  if (!p) return null;
  try { return { body: await fs.readFile(p), headers: JSON.parse(await fs.readFile(p + '.headers.json', 'utf8')) }; } catch { return null; }
}
async function writeCache(u, headers, body) {
  const p = cachePath(u);
  if (!p) return;
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    await fs.writeFile(p + '.headers.json', JSON.stringify(headers));
  } catch {}
}

async function passThroughNode(route, req) {
  if ('direct' in args) return route.continue();
  const u = new URL(req.url());
  if (req.method() === 'GET') {
    const hit = await readCache(u);
    if (hit) return route.fulfill({ status: 200, headers: hit.headers, body: hit.body });
  }
  try {
    const t0 = Date.now();
    const res = await fetchViaNode(route, req);
    const body = await res.body();
    const headers = cleanHeaders(res.headers());
    if (req.method() === 'GET' && res.status() === 200) await writeCache(u, headers, body);
    if (Date.now() - t0 > 10_000) console.log(`loaded ${u.pathname.split('/').pop()} (${Math.round(body.length / 1024)} KB) in ${Math.round((Date.now() - t0) / 1000)}s`);
    return route.fulfill({ status: res.status(), headers, body });
  } catch (e) {
    console.error('[request failed via node]', req.method(), req.url().split('?')[0], e.message.split('\n')[0]);
    return route.abort().catch(() => {});
  }
}

async function serveGameJs(route, req) {
  let res, body;
  try {
    res = await fetchViaNode(route, req);
    body = await res.text();
    console.log(`game.js: HTTP ${res.status()}, ${body.length} chars`);
  } catch (e) {
    console.error('Could not download game.js:', e.message.split('\n')[0]);
    return route.abort();
  }
  // Main tick: `let t=isRun?input.poll():demoBot.next(state);` -> the built-in bot drives real runs too.
  // Its inputs still go through the game's own per-second input cap and are recorded for server replay.
  const re = /let (\w+)=(\w+)\?(\w+)\.poll\(\):(\w+)\.next\((\w+)\);/;
  if (!re.test(body)) {
    console.error('game.js: hook not found, start of file:', JSON.stringify(body.slice(0, 80)));
    return route.continue();
  }
  body = body.replace(re, (_, t, e, x, z, s) =>
    `let ${t}=${e}?(globalThis.__guestBot?(globalThis.__guestState=${s},${z}.next(${s})):${x}.poll()):(globalThis.__guestState=${s},${z}.next(${s}));`);
  patched = true;
  const headers = cleanHeaders(res.headers());
  headers['content-type'] = 'text/javascript; charset=utf-8';
  headers['cache-control'] = 'no-store';
  return route.fulfill({ status: res.status(), headers, body });
}

await context.route('**/*', async route => {
  const req = route.request();
  const u = new URL(req.url());
  const onHost = u.hostname === HOST;
  if (onHost && u.pathname.endsWith('/src/run/game.js')) return serveGameJs(route, req);
  if (onHost && req.method() === 'GET' && isStaticAsset(u)) return passThroughNode(route, req);
  if (ONLINE) return onHost ? passThroughNode(route, req) : route.continue();
  blocked.add(`${req.method()} ${req.url().split('?')[0]}`);
  return route.abort();
});

const page = context.pages()[0] || await context.newPage();
if (!ONLINE) await page.setViewportSize({ width: 900, height: 1200 });
page.on('pageerror', e => console.error('[page error]', e.message));
page.on('requestfailed', r => {
  const u = r.url().split('?')[0];
  if (!blocked.has(`${r.method()} ${u}`)) console.error('[request failed]', u, r.failure()?.errorText);
});
let lastRunResponse = null;
page.on('response', async r => {
  const u = new URL(r.url());
  if (u.hostname === HOST && u.pathname === '/api/run' && r.request().method() === 'POST') {
    let data = null;
    try { data = await r.json(); } catch {}
    lastRunResponse = { status: r.status(), data };
  } else if (r.status() >= 400) {
    console.error('[http error]', r.status(), r.url().split('?')[0]);
  }
});
const pending = new Map();
page.on('request', r => pending.set(r, Date.now()));
page.on('requestfinished', r => pending.delete(r));
page.on('requestfailed', r => pending.delete(r));

console.log('Opening the game...');
await page.goto(URL_RUN, { waitUntil: 'commit', timeout: 90_000 });
const LOAD_LIMIT = Number(args.loadSeconds ?? 240) * 1000;
const loadStart = Date.now();
for (;;) {
  const ready = await page.waitForSelector('html.is-ready', { state: 'attached', timeout: 15_000 }).then(() => true, () => false);
  if (ready) break;
  const secs = Math.round((Date.now() - loadStart) / 1000);
  const slow = [...pending.entries()].filter(([, t]) => Date.now() - t > 10_000)
    .map(([r, t]) => `${r.url().split('?')[0]} (${Math.round((Date.now() - t) / 1000)}s)`);
  console.log(`still loading (${secs}s)${slow.length ? `, waiting for: ${slow.slice(0, 5).join(', ')}` : ''}`);
  if (Date.now() - loadStart > LOAD_LIMIT) {
    await page.screenshot({ path: 'bobble-debug.png' }).catch(() => {});
    throw new Error('Game did not finish loading. Screenshot saved to bobble-debug.png');
  }
}
console.log('Game loaded');
if (!patched) throw new Error('game.js changed: tick hook not found, bot cannot attach');

// Evaluate fails while the page reloads; treat that as "not known yet" instead of crashing the bot.
const readAuth = () => page.evaluate(key => {
  try {
    const a = (JSON.parse(localStorage.getItem(key) || '{}') || {}).auth;
    return a && a.address && !(a.expires && a.expires < Date.now()) ? a.address : null;
  } catch { return null; }
}, STORAGE_KEY).catch(() => null);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const METAMASK_ID = 'nkbihfbeogaeaoehlefnkodbefgpgknn';
const METAMASK_STORE = `https://chromewebstore.google.com/detail/metamask/${METAMASK_ID}`;
const MM_ORIGIN = `chrome-extension://${METAMASK_ID}/`;
const metamaskInstalled = () =>
  context.serviceWorkers().some(w => w.url().startsWith(MM_ORIGIN)) ||
  context.pages().some(p => p.url().startsWith(MM_ORIGIN));

if (ONLINE) {
  let address = await readAuth();
  if (!address) {
    // Give MetaMask a moment to start its service worker if it is already in the profile.
    await sleep(3000);
    if (!metamaskInstalled()) {
      console.log('\nMetaMask is not installed in this profile yet: opening its Chrome Web Store page.');
      console.log('Click "Install", then create or import a wallet (use a separate wallet without large funds).');
      const store = await context.newPage();
      await store.goto(METAMASK_STORE, { timeout: 90_000 }).catch(e => console.error('Could not open the store page:', e.message.split('\n')[0]));
      let note = 0;
      while (!metamaskInstalled()) {
        if (Date.now() - note > 60_000) { console.log('waiting for MetaMask to be installed...'); note = Date.now(); }
        await sleep(2000);
      }
      console.log('MetaMask installed. Finish the wallet setup in its tab.');
    }
    // The game only sees a wallet injected at page load, so reload until window.ethereum appears.
    const hasWallet = () => page.evaluate(() => typeof window.ethereum !== 'undefined').catch(() => false);
    if (!(await hasWallet())) {
      console.log('Reloading the game so it can see MetaMask...');
      await page.reload({ waitUntil: 'commit', timeout: 90_000 }).catch(() => {});
      await page.waitForSelector('html.is-ready', { state: 'attached', timeout: 240_000 }).catch(() => {});
    }
    console.log('\n=== Sign in once in the game tab ===');
    console.log('Open the save kit (wallet button), connect MetaMask, sign the message and finish the X steps.');
    console.log('The bot starts by itself after sign-in. Reloading the page is safe.\n');
    let lastNote = 0;
    while (!(address = await readAuth())) {
      if (Date.now() - lastNote > 60_000) { console.log('waiting for wallet sign-in...'); lastNote = Date.now(); }
      await sleep(3000);
    }
  }
  console.log(`Signed in as ${address.slice(0, 6)}…${address.slice(-4)} (saved in the profile, next launches start right away)`);
  await page.bringToFront().catch(() => {});
  await page.waitForSelector('html.is-ready', { state: 'attached', timeout: 240_000 });
} else {
  const authFound = await page.evaluate(() => typeof window.ethereum !== 'undefined');
  if (authFound || await readAuth()) throw new Error('Wallet/auth detected — guest mode refuses to run (use --online)');
}

async function clickWhenVisible(selector) {
  await page.waitForSelector(`${selector}:visible`, { timeout: 120_000 });
  // Boot overlay intercepts pointer events until loading finishes.
  await page.waitForFunction(() => {
    const b = document.getElementById('boot');
    if (!b) return true;
    const cs = getComputedStyle(b);
    return b.hidden || cs.display === 'none' || cs.pointerEvents === 'none' || cs.opacity === '0';
  }, null, { timeout: 60_000 }).catch(() => {});
  await page.click(selector, { force: true });
}

// In-flight page calls reject once the user quits; that is not an error worth printing.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, e => {
    if (closing) process.exit(0);
    console.error(e);
    process.exit(1);
  });
}

// Terminal hotkeys: L = let the current run end (it is saved as usual), P = pause/resume between runs.
let releaseRequested = false;
let paused = false;
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', async buf => {
    const k = buf.toString().toLowerCase();
    if (k === '\u0003') { // Ctrl+C is not delivered as a signal in raw mode
      closing = true;
      console.log('\nStopping...');
      context.close().catch(() => {}).finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000);
    } else if (k === 'l') {
      releaseRequested = true;
      console.log('[L] releasing control: the character will crash and the run will end');
    } else if (k === 'p') {
      paused = !paused;
      console.log(paused ? '[P] paused: no new run will start until you press P again' : '[P] resumed');
    }
  });
  console.log('Keys: L = end the current run now, P = pause/resume between runs, Ctrl+C = quit');
}

const results = [];
for (let i = 0; RUNS === 0 || i < RUNS; i++) {
  if (paused) {
    console.log('paused, press P to start the next run');
    while (paused) await sleep(500);
  }
  releaseRequested = false;
  await page.evaluate(() => { globalThis.__guestBot = true; });
  const again = await page.$('#btn-again:visible');
  await clickWhenVisible(again ? '#btn-again' : '#btn-play');
  lastRunResponse = null;
  const t0 = Date.now();
  let lastLog = 0;
  let released = false;
  let st;
  for (;;) {
    st = await page.evaluate(() => {
      const s = globalThis.__guestState || {};
      const a = document.querySelector('#btn-again');
      return { score: s.score, coins: s.coins, distance: Math.round(s.distance || 0), over: !!a && a.offsetParent !== null };
    }).catch(() => null);
    if (!st) {
      // Page reloaded mid-run: that run is lost, start a new one once the game is ready again.
      console.log(`run ${i + 1}: page was reloaded, starting over`);
      await page.waitForSelector('html.is-ready', { state: 'attached', timeout: 240_000 }).catch(() => {});
      st = { score: 0, coins: 0, distance: 0, reloaded: true };
      break;
    }
    if (Date.now() - lastLog > 5000) {
      console.log(`run ${i + 1}: score=${st.score} coins=${st.coins} dist=${st.distance}`);
      lastLog = Date.now();
      if (SHOT) await page.screenshot({ path: `${SHOT}-${i + 1}.png` });
    }
    if (st.over) break;
    if (!released && releaseRequested) {
      await page.evaluate(() => { globalThis.__guestBot = false; }).catch(() => {});
      released = true;
    }
    if (!released && MAX_RUN_MS && Date.now() - t0 > MAX_RUN_MS) {
      // Stop steering so the run ends and is submitted while the game session is still valid.
      console.log(`run ${i + 1}: reached ${MAX_RUN_MS / 60000} min, finishing the run so it can be saved`);
      await page.evaluate(() => { globalThis.__guestBot = false; });
      released = true;
    }
    if (!ONLINE && args.maxSeconds && Date.now() - t0 > Number(args.maxSeconds) * 1000) { st.stopped = true; break; }
    await page.waitForTimeout(500);
  }
  if (ONLINE && !st.reloaded) {
    const deadline = Date.now() + 60_000;
    while (!lastRunResponse && Date.now() < deadline) await page.waitForTimeout(1000);
    if (!lastRunResponse) console.log(`run ${i + 1}: no save response from the server (check the game window)`);
    else {
      const d = lastRunResponse.data || {};
      const info = ['saved', 'score', 'coins', 'rank', 'tickets', 'best', 'error', 'code'].filter(k => d[k] !== undefined).map(k => `${k}=${d[k]}`).join(' ');
      console.log(`run ${i + 1} saved: HTTP ${lastRunResponse.status} ${info}`);
    }
    await page.waitForTimeout(3000 + Math.random() * 4000);
  }
  results.push(st);
  console.log(`run ${i + 1} finished: score=${st.score} coins=${st.coins} dist=${st.distance}${st.stopped ? ' (stopped by --maxSeconds)' : ''}`);
  if (st.stopped) break;
}

if (!ONLINE) {
  console.log(`\nBlocked ${blocked.size} non-asset requests (nothing was sent to the leaderboard):`);
  for (const b of [...blocked].slice(0, 20)) console.log('  ', b);
}
closing = true;
await context.close();
if (browser) await browser.close();
