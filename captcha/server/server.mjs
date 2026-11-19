#!/usr/bin/env node
/**
 * portal-captcha —— 人机验证 hub（Turnstile 式无感验证 + 图片点选兜底）
 *
 * 位置：127.0.0.1:5111（仅回环；门户经 nginx :5000 的 /api/captcha/ 进来，
 *       100card 经其 server/index.js 的 /captcha/ 反代进来）
 *
 * 职责：
 *  1. POST {prefix}/init              签发一次性 nonce {cid, ttl}
 *  2. POST {prefix}/verify           服务端评分（motion-attestation analyze）：
 *        score ≥ PASS  → 直接签发一次性令牌（人类无感直通）
 *        score 低      → {challenge:true, ccid}，前端改走图片点选兜底
 *  3. GET  {prefix}/challenge?ccid=   代理 go-captcha-service(:5112) 生成图形点选挑战
 *                                     （必须携带 verify 签发的续接凭证 ccid）
 *  4. POST {prefix}/challenge/verify  代理 check-data（须携带 ccid）；通过后烧毁 ccid 并签发令牌
 *  5. POST /c/consume                 烧毁 jti（注册成功时由 gate / 100card 回环调用）
 *  6. GET  {prefix}/assets/*          前端静态资产（widget / collector / bot-signal / gocaptcha）
 *
 * 令牌格式：b64url(payloadJSON) + "." + b64url(hmac-sha256(payload))
 *   payload = {v:1, typ:'captcha-pass', jti, iat, exp, score}
 *   gate / 100card 用共享密钥 PORTAL_CAPTCHA_SECRET 本地验签（node:crypto 即可），
 *   注册成功后回环调 /c/consume 烧毁 jti，令牌同时受 5 分钟 TTL 约束。
 *
 * prefix 同时响应 /api/captcha 与 /captcha 两种前缀（门户 / 卡牌各自的路由习惯）。
 * 密钥来源：systemd EnvironmentFile 注入 → PORTAL_CAPTCHA_SECRET（见 DEPLOY.md）。
 */
'use strict';

import http from 'node:http';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from 'motion-attestation';

const PORT = Number(process.env.PORT) || 5111;
const HOST = '127.0.0.1';
const SECRET = process.env.PORTAL_CAPTCHA_SECRET || '';
const GOCAP_BASE = process.env.GOCAP_BASE || 'http://127.0.0.1:5112/api/v1/public';
const CHALLENGE_ID = process.env.CAPTCHA_CHALLENGE_ID || 'click-shape-default';
const SCORE_PASS = Number(process.env.CAPTCHA_SCORE_PASS || 0.7); // 2026-11-19 由 0.5 提至 0.7：收紧"证据不足宽松放行"（手机端直通/简单合成点击过线）的窗口

const CID_TTL = 2 * 60 * 1000;      // init → verify 窗口（ccid 同 TTL）
const TOKEN_TTL = 2 * 60 * 1000;    // 令牌有效期（2026-11-19 由 5min 收紧至 2min）
const BODY_LIMIT = 256 * 1024;      // verify 上传的轨迹 JSON 上限
const SWEEP_MS = 30 * 1000;

const PREFIXES = ['/api/captcha', '/captcha'];
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// bot-signal 即时检查里“一票否决”的自动化指纹（widget 上报，仅作降分信号，不作放行依据）
const BSI_DEFINITIVE = new Set([
  'isWebDriver', 'isPlaywright', 'isPuppeteer', 'isChromeDriver', 'isSelenium',
  'isPhantomJS', 'isNightmare', 'isDomAutomation', 'isHeadless',
  'isSuspiciousWebDriverDescriptor',
]);

if (!SECRET || SECRET.length < 32) {
  console.error('[captcha] 致命：PORTAL_CAPTCHA_SECRET 未设置或过短（需 >=32 字符）。拒绝启动。');
  process.exit(1);
}

// ---------------------------------------------------------------- 会话状态（内存态，重启即清）

/** cid → {iat, ip}：verify 一次性消费 */
const cids = new Map();
/** ccid → {iat, ip}：挑战续接凭证（verify 低分后签发；拉图/点选校验必须携带，
 *  绑定 IP、成功即烧毁——堵死"跳过 init/verify 直接刷挑战"的脚本路径） */
const ccids = new Map();
/** jti → 过期时刻：令牌烧毁记录（防同一令牌注册多个账号） */
const burned = new Map();
/** ip → {init, verify, challenge} 计数（分钟窗口，防接口滥用） */
const rate = new Map();

function sweepStores() {
  const now = Date.now();
  for (const [k, v] of cids) if (now - v.iat > CID_TTL) cids.delete(k);
  for (const [k, v] of ccids) if (now - v.iat > CID_TTL) ccids.delete(k);
  for (const [k, exp] of burned) if (now > exp) burned.delete(k);
  for (const [ip, buckets] of rate) {
    for (const [name, arr] of Object.entries(buckets)) {
      while (arr.length && now - arr[0] > 60 * 1000) arr.shift();
      if (!arr.length) delete buckets[name];
    }
    if (!Object.keys(buckets).length) rate.delete(ip);
  }
}
setInterval(sweepStores, SWEEP_MS).unref();

function hitRate(ip, name, limit) {
  let b = rate.get(ip);
  if (!b) { b = {}; rate.set(ip, b); }
  let arr = b[name];
  if (!arr) { arr = []; b[name] = arr; }
  const now = Date.now();
  while (arr.length && now - arr[0] > 60 * 1000) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}

// ---------------------------------------------------------------- 工具

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function issueToken(score) {
  const payload = {
    v: 1,
    typ: 'captcha-pass',
    jti: crypto.randomBytes(16).toString('hex'),
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL,
    score,
  };
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest();
  return body + '.' + b64url(mac);
}

function verifyToken(token) {
  try {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const mac = crypto.createHmac('sha256', SECRET).update(body).digest();
    const sigBuf = Buffer.from(sig, 'base64url');
    if (mac.length !== sigBuf.length || !crypto.timingSafeEqual(mac, sigBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.typ !== 'captcha-pass' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function clientIp(req) {
  const cip = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cip) return cip;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('bad json'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- go-captcha-service 代理

async function gocapGetData() {
  const r = await fetch(`${GOCAP_BASE}/get-data?id=${encodeURIComponent(CHALLENGE_ID)}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`get-data HTTP ${r.status}`);
  const j = await r.json();
  const d = j && j.data;
  if (!d || !d.captcha_key) throw new Error('get-data empty');
  return d;
}

async function gocapCheck(captchaKey, dots) {
  if (!Array.isArray(dots) || !dots.length || dots.length > 8) return null;
  const value = dots
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
    .join(',');
  if (!value || value.includes('NaN')) return null;
  const r = await fetch(`${GOCAP_BASE}/check-data`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: CHALLENGE_ID, captchaKey, value }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`check-data HTTP ${r.status}`);
  const j = await r.json();
  return j && j.data === 'ok';
}

// ---------------------------------------------------------------- 静态资产

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

async function serveAsset(res, relPath) {
  const safe = path.normalize(relPath).replace(/^([./\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'public, max-age=600',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

// ---------------------------------------------------------------- 路由

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  let pathname = decodeURIComponent(url.pathname);

  let prefix = null;
  for (const p of PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/')) { prefix = p; break; }
  }

  // 回环直调端点（gate / 100card 注册时先行烧毁令牌，同一令牌只允许成功注册一次）
  if (!prefix && pathname === '/c/consume' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = verifyToken(body.token);
    if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid token' });
    if (burned.has(payload.jti)) return sendJson(res, 200, { ok: false, error: 'already used' });
    burned.set(payload.jti, payload.exp);
    return sendJson(res, 200, { ok: true });
  }
  if (!prefix && pathname === '/c/verify-local' && req.method === 'POST') {
    // 诊断端点：本地验签 + 是否已烧毁（不烧毁）
    const body = await readBody(req);
    const payload = verifyToken(body.token);
    if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid token' });
    return sendJson(res, 200, { ok: true, payload, consumed: burned.has(payload.jti) });
  }

  if (!prefix) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
  const sub = pathname.slice(prefix.length).replace(/^\/+/, ''); // '' 或 'init' / 'verify' / ...

  const ip = clientIp(req);

  // ---- 静态资产：{prefix}/assets/xxx（文件统一放在 public/assets/ 下） ----
  if (sub.startsWith('assets/')) {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    return serveAsset(res, sub);
  }

  // ---- init ----
  if (sub === 'init' && req.method === 'POST') {
    if (!hitRate(ip, 'init', 12)) return sendJson(res, 429, { error: '请求过于频繁，请稍后再试' }, { 'retry-after': '30' });
    const cid = crypto.randomBytes(16).toString('hex');
    cids.set(cid, { iat: Date.now(), ip });
    return sendJson(res, 200, { cid, ttl: CID_TTL });
  }

  // ---- verify：服务端行为评分 ----
  if (sub === 'verify' && req.method === 'POST') {
    if (!hitRate(ip, 'verify', 12)) return sendJson(res, 429, { error: '请求过于频繁，请稍后再试' }, { 'retry-after': '30' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, e.code || 400, { error: '请求数据不合法' }); }

    const rec = cids.get(String(body.cid || ''));
    if (!rec || Date.now() - rec.iat > CID_TTL) {
      return sendJson(res, 400, { ok: false, error: '验证会话已过期，请重试' });
    }
    cids.delete(rec && String(body.cid || '')); // cid 一次性
    // IP 只记日志不做硬校验（2026-11-19）：移动运营商 NAT 出口会在会话间漂移、双栈浏览器可能 v4/v6 切换，
    // 严格绑定会随机误伤真人；cid 本身一次性 + 2min TTL，令牌签发仍需解题，绑定 IP 无实际安全增益
    if (rec.ip !== ip) console.log(`[captcha] verify ip-switch ${rec.ip} -> ${ip}（放行）`);

    let result;
    try { result = analyze(body.d || {}); } catch { result = null; }
    let score = result ? Number(result.score) : 0;
    let forced = null;
    const flags = Array.isArray(body.bsi) ? body.bsi.map(String) : [];
    for (const f of flags) if (BSI_DEFINITIVE.has(f)) { forced = f; break; }
    if (forced) score = Math.min(score, 0.1);

    const topReasons = (result && Array.isArray(result.reasons) ? result.reasons : []).slice(0, 3);
    console.log(`[captcha] verify ip=${ip} score=${score.toFixed(3)}${forced ? ` forced=${forced}` : ''}` +
      (topReasons.length ? ` reasons=${topReasons.map((r) => String(r)).join(' | ')}` : ''));

    if (score >= SCORE_PASS) {
      return sendJson(res, 200, { ok: true, token: issueToken(score), score });
    }
    // 低分 → 签发一次性挑战续接凭证（challenge / challenge/verify 必须携带）
    const ccid = crypto.randomBytes(16).toString('hex');
    ccids.set(ccid, { iat: Date.now(), ip });
    return sendJson(res, 200, { ok: false, challenge: true, ccid });
  }

  // ---- challenge：代理 go-captcha 点选（必须携带有效 ccid；拉图不烧毁，允许刷新） ----
  if (sub === 'challenge' && req.method === 'GET') {
    if (!hitRate(ip, 'challenge', 10)) return sendJson(res, 429, { error: '请求过于频繁，请稍后再试' }, { 'retry-after': '30' });
    const ccidRec = ccids.get(String(url.searchParams.get('ccid') || ''));
    if (!ccidRec || Date.now() - ccidRec.iat > CID_TTL) {
      return sendJson(res, 400, { ok: false, error: '验证会话无效，请重新完成人机验证' });
    }
    try {
      const d = await gocapGetData();
      return sendJson(res, 200, {
        key: d.captcha_key,
        image: d.master_image_base64,
        thumb: d.thumb_image_base64,
        width: d.master_width,
        height: d.master_height,
        thumbWidth: d.thumb_width,
        thumbHeight: d.thumb_height,
      });
    } catch (e) {
      console.error('[captcha] get-data 失败:', e.message);
      return sendJson(res, 502, { ok: false, error: '挑战生成失败，请稍后重试' });
    }
  }

  if (sub === 'challenge/verify' && req.method === 'POST') {
    if (!hitRate(ip, 'challengeVerify', 8)) return sendJson(res, 429, { error: '请求过于频繁，请稍后再试' }, { 'retry-after': '30' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, e.code || 400, { error: '请求数据不合法' }); }
    const ccidStr = String(body.ccid || '');
    const ccidRec = ccids.get(ccidStr);
    if (!ccidRec || Date.now() - ccidRec.iat > CID_TTL) {
      return sendJson(res, 400, { ok: false, error: '验证会话无效，请重新完成人机验证' });
    }
    try {
      const ok = await gocapCheck(String(body.key || ''), body.dots);
      console.log(`[captcha] challenge ip=${ip} key=${String(body.key)} ok=${ok === true}`);
      if (ok === true) {
        ccids.delete(ccidStr); // 点选通过：烧毁续接凭证，一次挑战只换一枚令牌
        return sendJson(res, 200, { ok: true, token: issueToken(0.4) });
      }
      return sendJson(res, 200, { ok: false, error: '点选不正确，请重试' });
    } catch (e) {
      console.error('[captcha] check-data 失败:', e.message);
      return sendJson(res, 502, { ok: false, error: '验证服务暂时不可用，请稍后重试' });
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error('[captcha] 未捕获异常:', e && e.stack || e);
    if (!res.headersSent) sendJson(res, 500, { error: '内部错误' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[captcha] portal-captcha 运行于 http://${HOST}:${PORT}（score-pass=${SCORE_PASS}, challenge=${CHALLENGE_ID}）`);
});
