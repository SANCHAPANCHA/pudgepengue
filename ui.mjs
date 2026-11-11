// Local control panel for bot.mjs: http://127.0.0.1:5577 (only reachable from this computer).
// Each profile runs as its own bot process; settings are kept in bobble-ui.json next to this file.
import http from 'node:http';
import { fork, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BOBBLE_UI_PORT || 5577);
const SETTINGS_FILE = path.join(DIR, 'bobble-ui.json');
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const GUEST = process.argv.includes('--guest');
const folderOf = name => (name === 'main' ? 'bobble-profile' : `profile-${name}`);

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (s && Array.isArray(s.profiles)) return s;
  } catch {}
  const profiles = [{ name: 'main', stopScore: 0, stopCoins: 0, autoContinue: false }];
  for (const d of fs.readdirSync(DIR)) {
    const m = /^profile-([A-Za-z0-9_-]{1,40})$/.exec(d);
    if (m && fs.statSync(path.join(DIR, d)).isDirectory()) profiles.push({ name: m[1], stopScore: 0, stopCoins: 0, autoContinue: false });
  }
  return { proxy: process.env.BOBBLE_PROXY || '', profiles };
}
const settings = loadSettings();
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
saveSettings();

const bots = new Map(); // name -> { child, state, ... }
const clients = new Set();
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}
function botView(name) {
  const b = bots.get(name);
  if (!b) return { running: false, state: 'stopped', logs: [] };
  const { child, ...rest } = b;
  return { ...rest, running: !!child };
}
function pushLog(name, line) {
  const b = bots.get(name);
  if (!b || !line.trim()) return;
  b.logs.push(line);
  if (b.logs.length > 300) b.logs.splice(0, b.logs.length - 300);
  broadcast({ type: 'log', name, line });
}
function update(name, patch) {
  const b = bots.get(name);
  Object.assign(b, patch);
  broadcast({ type: 'bot', name, bot: botView(name) });
}

function startBot(name) {
  const p = settings.profiles.find(x => x.name === name);
  if (!p) throw new Error('unknown profile');
  if (bots.get(name)?.child) return;
  // --guest: demo without a wallet, nothing is saved.
  const args = [...(GUEST ? ['--runs=0'] : ['--online']), `--profile=${folderOf(name)}`, `--stopScore=${p.stopScore || 0}`, `--stopCoins=${p.stopCoins || 0}`];
  if (p.autoContinue) args.push('--autoContinue');
  const env = { ...process.env };
  // Proxy goes through the environment so the password does not show up in process lists.
  if (settings.proxy) env.BOBBLE_PROXY = settings.proxy; else delete env.BOBBLE_PROXY;
  const child = fork(path.join(DIR, 'bot.mjs'), args, { cwd: DIR, env, silent: true });
  const prev = bots.get(name);
  bots.set(name, { child, state: 'starting', run: 0, score: 0, coins: 0, distance: 0, runsDone: 0, savedOk: 0,
    lastSave: null, account: prev?.account || null, logs: prev?.logs || [], limits: p });
  update(name, {});
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', d => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) pushLog(name, l);
    });
  }
  child.on('message', m => {
    const b = bots.get(name);
    if (!b || b.child !== child) return;
    if (m.type === 'state') {
      const patch = { state: m.state };
      for (const k of ['run', 'score', 'coins', 'distance', 'startedAt']) if (m[k] !== undefined) patch[k] = m[k];
      update(name, patch);
    } else if (m.type === 'saved') {
      update(name, { lastSave: { ok: m.ok, info: m.info, run: m.run, at: Date.now() }, savedOk: b.savedOk + (m.ok ? 1 : 0) });
    } else if (m.type === 'finished') {
      update(name, { runsDone: b.runsDone + 1, best: Math.max(b.best || 0, m.score || 0) });
    } else if (m.type === 'account') {
      update(name, { account: m.address });
    } else if (m.type === 'limits') {
      update(name, { limits: m.limits });
    }
  });
  child.on('exit', code => {
    const b = bots.get(name);
    if (b && b.child === child) {
      pushLog(name, `bot exited (code ${code})`);
      update(name, { child: null, state: code === 0 ? 'stopped' : 'error' });
    }
  });
}

function send(name, msg) {
  const b = bots.get(name);
  if (b?.child?.connected) b.child.send(msg);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const num = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(DIR, 'ui.html')));
    }
    if (req.method === 'GET' && u.pathname === '/api/state') {
      const view = {};
      for (const p of settings.profiles) view[p.name] = botView(p.name);
      return json(res, 200, { settings: { ...settings, proxy: settings.proxy ? maskProxy(settings.proxy) : '', hasProxy: !!settings.proxy }, bots: view });
    }
    if (req.method === 'GET' && u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    // Custom header blocks cross-site form posts from other pages open in the browser.
    if (req.method === 'POST' && req.headers['x-bobble'] !== '1') return json(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const body = await readBody(req);
    if (u.pathname === '/api/proxy') {
      settings.proxy = String(body.proxy || '').trim();
      saveSettings();
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/profiles/add') {
      const name = String(body.name || '').trim();
      if (!NAME_RE.test(name)) return json(res, 400, { error: 'Имя: латиница, цифры, - и _' });
      if (settings.profiles.some(p => p.name === name)) return json(res, 400, { error: 'Такой профиль уже есть' });
      settings.profiles.push({ name, stopScore: 0, stopCoins: 0, autoContinue: false });
      saveSettings();
      return json(res, 200, { ok: true });
    }
    const m = /^\/api\/bot\/([A-Za-z0-9_-]{1,40})\/(start|cmd|stop|limits|remove)$/.exec(u.pathname);
    if (!m) return json(res, 404, { error: 'not found' });
    const [, name, action] = m;
    const p = settings.profiles.find(x => x.name === name);
    if (!p) return json(res, 404, { error: 'unknown profile' });
    if (action === 'limits') {
      p.stopScore = num(body.stopScore);
      p.stopCoins = num(body.stopCoins);
      p.autoContinue = !!body.autoContinue;
      saveSettings();
      send(name, { cmd: 'setLimits', score: p.stopScore, coins: p.stopCoins, autoContinue: p.autoContinue });
      if (bots.get(name)) update(name, { limits: p });
      return json(res, 200, { ok: true });
    }
    if (action === 'start') { startBot(name); return json(res, 200, { ok: true }); }
    if (action === 'stop') { send(name, { cmd: 'quit' }); return json(res, 200, { ok: true }); }
    if (action === 'cmd') {
      if (!['release', 'pause', 'resume'].includes(body.cmd)) return json(res, 400, { error: 'bad cmd' });
      send(name, { cmd: body.cmd });
      return json(res, 200, { ok: true });
    }
    if (action === 'remove') {
      if (bots.get(name)?.child) return json(res, 400, { error: 'Сначала остановите бота' });
      settings.profiles = settings.profiles.filter(x => x.name !== name);
      bots.delete(name);
      saveSettings();
      return json(res, 200, { ok: true });
    }
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

function maskProxy(p) {
  const m = /^(?:(\w+):\/\/)?([^:@/]+):(\d+)/.exec(p.replace(/^(\w+:\/\/)?[^@]*@/, '$1'));
  return m ? `${m[1] || 'http'}://${m[2]}:${m[3]} (логин скрыт)` : 'задан';
}

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Bobble bot panel${GUEST ? " (GUEST demo: nothing is saved)" : ""}: ${url}  (keep this window open, Ctrl+C to quit)`);
  if (!process.argv.includes('--no-open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
  }
});

function shutdown() {
  for (const [, b] of bots) if (b.child?.connected) b.child.send({ cmd: 'quit' });
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
