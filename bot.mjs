// Guest-mode autoplayer for Bobble Run (https://unboxbobble.com/run).
// Runs are never saved: fresh profile without a wallet, every request except
// static game assets is aborted, and the bot refuses to start if any auth is found.
import { chromium } from 'playwright';

const URL_RUN = 'https://unboxbobble.com/run';
const HOST = 'unboxbobble.com';
const VERSION = 'v9';
console.log(`Bobble guest bot ${VERSION}, node ${process.version}, ${process.platform}`);
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const RUNS = Number(args.runs ?? 1);
const HEADLESS = !('headed' in args);
const SHOT = args.screenshot; // optional path prefix for screenshots

const blocked = new Set();
let patched = false;

function isStaticAsset(url) {
  const u = new URL(url);
  if (u.hostname !== HOST) return false;
  return u.pathname === '/run' || u.pathname.startsWith('/v/') || /\.(woff2?|ttf|png|jpe?g|webp|svg|glb|gltf|ktx2|mp3|ogg|wav|css|ico)$/.test(u.pathname);
}

// Software WebGL only for GPU-less servers (Linux/headless); on a desktop it can crash the browser.
const launchArgs = ['--autoplay-policy=no-user-gesture-required', '--disable-quic'];
if ('swiftshader' in args || (HEADLESS && process.platform === 'linux')) {
  launchArgs.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
}
// Accepts scheme://host:port, scheme://user:pass@host:port, or scheme://host:port:user:pass.
function parseProxy(raw) {
  if (!raw) return undefined;
  const m = /^(?:(\w+):\/\/)?([^:@/]+):(\d+):([^:]+):(.+)$/.exec(raw);
  if (m) return { server: `${m[1] || 'http'}://${m[2]}:${m[3]}`, username: m[4], password: m[5] };
  const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const p = { server: `${u.protocol}//${u.host}` };
  if (u.username) { p.username = decodeURIComponent(u.username); p.password = decodeURIComponent(u.password); }
  return p;
}
const PROXY = parseProxy(args.proxy || process.env.BOBBLE_PROXY);
if (PROXY) console.log(`Proxy: ${PROXY.server}${PROXY.username ? ' (with login)' : ''}`);
const channels = args.channel ? [args.channel]
  : process.platform === 'win32' ? [undefined, 'msedge', 'chrome'] : [undefined, 'chrome'];
let browser;
for (const channel of channels) {
  try {
    browser = await chromium.launch({ headless: HEADLESS, args: launchArgs, channel, proxy: PROXY });
    console.log(`Browser: ${channel || 'playwright chromium'}, ${HEADLESS ? 'hidden (add --headed to see it)' : 'window visible'}`);
    break;
  } catch (e) {
    console.warn(`Could not start ${channel || 'playwright chromium'}: ${e.message.split('\n')[0]}`);
  }
}
if (!browser) throw new Error('No browser could be started. Run: npx playwright install chromium');
let closing = false;
browser.on('disconnected', () => {
  if (closing) return;
  console.error('\nBrowser closed. Do not close the game window while the bot runs.');
  process.exit(1);
});
const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });

function cleanHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!/^(content-encoding|content-length|transfer-encoding|etag|last-modified)$/i.test(k)) out[k] = v;
  }
  return out;
}

async function fetchViaNode(route, req) {
  return route.fetch({ timeout: 60_000, maxRetries: 2, headers: { ...req.headers(), 'accept-encoding': 'identity' } });
}

await context.route('**/*', async route => {
  const req = route.request();
  const url = req.url();
  if (req.method() !== 'GET' || !isStaticAsset(url)) {
    blocked.add(`${req.method()} ${url.split('?')[0]}`);
    return route.abort();
  }
  if (!/\/src\/run\/game\.js$/.test(new URL(url).pathname)) {
    // Some networks stall Chromium's own requests to Cloudflare while Node's work, so assets go through Node.
    if ('direct' in args) return route.continue();
    try {
      const res = await fetchViaNode(route, req);
      return route.fulfill({ status: res.status(), headers: cleanHeaders(res.headers()), body: await res.body() });
    } catch (e) {
      console.error('[asset failed]', url.split('?')[0], e.message.split('\n')[0]);
      return route.abort().catch(() => {});
    }
  }
  {
    let res, body;
    try {
      res = await fetchViaNode(route, req);
      body = await res.text();
      console.log(`game.js: HTTP ${res.status()}, ${body.length} chars, encoding=${res.headers()['content-encoding'] || 'none'}`);
    } catch (e) {
      console.error('Could not download game.js:', e.message.split('\n')[0]);
      return route.abort();
    }
    // Main tick: `let t=isRun?input.poll():demoBot.next(state);` -> let the built-in bot drive guest runs too.
    const re = /let (\w+)=(\w+)\?(\w+)\.poll\(\):(\w+)\.next\((\w+)\);/;
    if (re.test(body)) {
      body = body.replace(re, (_, t, e, x, z, s) =>
        `let ${t}=${e}?(globalThis.__guestBot?(globalThis.__guestState=${s},${z}.next(${s})):${x}.poll()):(globalThis.__guestState=${s},${z}.next(${s}));`);
      patched = true;
    } else {
      console.error('game.js: hook not found, start of file:', JSON.stringify(body.slice(0, 80)));
      return route.continue();
    }
    // Body is already decoded and modified: original encoding/length headers would corrupt it.
    const headers = cleanHeaders(res.headers());
    headers['content-type'] = 'text/javascript; charset=utf-8';
    headers['cache-control'] = 'no-store';
    return route.fulfill({ status: res.status(), headers, body });
  }
});

const page = await context.newPage();
page.on('pageerror', e => console.error('[page error]', e.message));
page.on('requestfailed', r => {
  const u = r.url().split('?')[0];
  if (!blocked.has(`${r.method()} ${u}`)) console.error('[request failed]', u, r.failure()?.errorText);
});
page.on('response', r => {
  if (r.status() >= 400) console.error('[http error]', r.status(), r.url().split('?')[0]);
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
  const boot = await page.evaluate(() => (document.getElementById('boot')?.innerText || '').trim().slice(0, 80)).catch(() => '');
  console.log(`still loading (${secs}s)${boot ? `, screen: "${boot}"` : ''}${slow.length ? `, waiting for: ${slow.slice(0, 5).join(', ')}` : ''}`);
  if (Date.now() - loadStart > LOAD_LIMIT) {
    await page.screenshot({ path: 'bobble-debug.png' }).catch(() => {});
    throw new Error('Game did not finish loading. Screenshot saved to bobble-debug.png');
  }
}
console.log('Game loaded, starting the bot');
if (!patched) throw new Error('game.js changed: tick hook not found, bot cannot attach');

const authFound = await page.evaluate(() => {
  const hasEth = typeof window.ethereum !== 'undefined';
  const stored = Object.keys(localStorage).some(k => /auth|address|wallet/i.test(localStorage.getItem(k) || ''));
  return hasEth || stored;
});
if (authFound) throw new Error('Wallet/auth detected — guest bot refuses to run');

const results = [];
for (let i = 0; i < RUNS; i++) {
  await page.evaluate(() => { globalThis.__guestBot = true; });
  const startBtn = i === 0 ? '#btn-play' : '#btn-again';
  await page.waitForSelector(`${startBtn}:visible`, { timeout: 60_000 });
  // Boot overlay intercepts pointer events until loading finishes.
  await page.waitForFunction(() => {
    const b = document.getElementById('boot');
    if (!b) return true;
    const cs = getComputedStyle(b);
    return b.hidden || cs.display === 'none' || cs.pointerEvents === 'none' || cs.opacity === '0';
  }, null, { timeout: 60_000 }).catch(() => {});
  await page.click(startBtn, { force: true });
  const t0 = Date.now();
  let lastLog = 0;
  // Game over screen shows #btn-again; poll live state meanwhile.
  for (;;) {
    const st = await page.evaluate(() => {
      const s = globalThis.__guestState || {};
      const again = document.querySelector('#btn-again');
      return { score: s.score, coins: s.coins, distance: s.distance, cause: s.cause,
        over: !!again && again.offsetParent !== null };
    });
    if (Date.now() - lastLog > 5000) {
      console.log(`run ${i + 1}: score=${st.score} coins=${st.coins} dist=${Math.round(st.distance || 0)}`);
      lastLog = Date.now();
      if (SHOT) await page.screenshot({ path: `${SHOT}-${i + 1}.png` });
    }
    if (st.over) { results.push(st); break; }
    if (args.maxSeconds && Date.now() - t0 > Number(args.maxSeconds) * 1000) { results.push({ ...st, stopped: true }); break; }
    await page.waitForTimeout(500);
  }
  console.log(`run ${i + 1} finished:`, results.at(-1));
}

console.log(`\nBlocked ${blocked.size} non-asset requests (nothing was sent to the leaderboard):`);
for (const b of [...blocked].slice(0, 20)) console.log('  ', b);
closing = true;
await browser.close();
