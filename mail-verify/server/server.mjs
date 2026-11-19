#!/usr/bin/env node
/**
 * portal-mail-verify —— 邮箱验证码服务（可迁移套件 · 服务端）
 *
 * 职责：给各应用的注册流程提供「邮箱验证码」环节。
 *   POST {任意前缀}/send    {email, captchaToken}  → 人机验证令牌验签+烧毁 → 发验证码邮件
 *   POST {任意前缀}/verify  {email, code}          → 校验通过签发一次性收据 receipt
 *   POST {任意前缀}/consume {receipt}              → 烧毁收据（各应用注册成功前调用）
 *   GET  {任意前缀}/health                          → 健康检查
 *
 * 设计要点（与 portal-captcha hub 同一风格）：
 *  - 零依赖（node:crypto / net / tls / http），仅监听回环 127.0.0.1:5113
 *  - 验证码邮件走配置的 SMTP（默认本机 Postfix 587 STARTTLS，可接任意中继）以 MAILV_FROM_EMAIL 发出
 *  - 人机验证令牌：本地 HMAC 验签（PORTAL_CAPTCHA_SECRET）+ 回环调 hub /c/consume 先烧后发
 *  - 验证码：6 位数字，HMAC-SHA256 存储，TTL 10 分钟，最多 5 次尝试
 *  - 收据 receipt：b64url(payload).b64url(hmac)，typ='mail-verified'，TTL 15 分钟，jti 一次性
 *  - 限速：同邮箱 60s 冷却 / 10 次·天；同 IP 20 次·天（宁可失败不可放行）
 *  - 状态持久化 /var/lib/mail-verify/state.json（原子写，重启不丢冷却/收据）
 *
 * 路由前缀自适应：/api/mailv/*、/mailv/*、/v/* 一律按最后一个段匹配，
 * 与 portal-captcha hub「prefix 同响应」的做法一致，方便各站反代时用任意前缀。
 */
'use strict';

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';

// ---------------------------------------------------------------- 配置
const CFG = {
  PORT: Number(process.env.PORT || 5113),
  HOST: process.env.MAILV_HOST || '127.0.0.1',
  SECRET: process.env.MAILV_SECRET || '',
  CAPTCHA_SECRET: process.env.PORTAL_CAPTCHA_SECRET || '',
  CAPTCHA_HUB: process.env.CAPTCHA_HUB || 'http://127.0.0.1:5111',
  SMTP_HOST: process.env.MAILV_SMTP_HOST || '127.0.0.1',
  SMTP_PORT: Number(process.env.MAILV_SMTP_PORT || 587),
  SMTP_TLS: process.env.MAILV_SMTP_TLS || 'starttls', // starttls（默认，本机 Postfix）| none（测试/25 端口明文）
  SMTP_USER: process.env.MAILV_SMTP_USER || '',
  SMTP_PASS: process.env.MAILV_SMTP_PASS || '',
  FROM_EMAIL: process.env.MAILV_FROM_EMAIL || process.env.MAILV_SMTP_USER || '',
  FROM_NAME: process.env.MAILV_FROM_NAME || 'MailVerify',
  BRAND: process.env.MAILV_BRAND || 'MailVerify',
  CODE_TTL: Number(process.env.MAILV_CODE_TTL || 600),          // 验证码有效期（秒）
  CODE_MAX_ATTEMPTS: Number(process.env.MAILV_CODE_MAX_ATTEMPTS || 5),
  RESEND_COOLDOWN: Number(process.env.MAILV_RESEND_COOLDOWN || 60), // 同邮箱重发冷却（秒）
  SEND_PER_EMAIL_DAY: Number(process.env.MAILV_SEND_PER_EMAIL_DAY || 10),
  SEND_PER_IP_DAY: Number(process.env.MAILV_SEND_PER_IP_DAY || 20),
  RECEIPT_TTL: Number(process.env.MAILV_RECEIPT_TTL || 900),    // 收据有效期（秒）
  STATE_DIR: process.env.MAILV_STATE_DIR || '/var/lib/mail-verify',
};

if (!CFG.SECRET || CFG.SECRET.length < 32) {
  console.error('[mail-verify] MAILV_SECRET 未注入或 <32 字符，拒绝启动');
  process.exit(1);
}

// ---------------------------------------------------------------- 状态（含持久化）
const STATE_FILE = path.join(CFG.STATE_DIR, 'state.json');
const state = {
  // email -> {h: code 的 HMAC, exp, attempts, jti, lastSent}
  codes: new Map(),
  // 待烧毁收据 jti 集合（值 = 过期时间戳 ms）
  pending: new Map(),
  // 限速计数：key 'e:邮箱:YYYYMMDD' / 'ip:IP:YYYYMMDD' -> count
  counters: new Map(),
};

function saveState() {
  try {
    fs.mkdirSync(CFG.STATE_DIR, { recursive: true });
    const obj = {
      codes: [...state.codes.entries()],
      pending: [...state.pending.entries()],
      counters: [...state.counters.entries()],
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[mail-verify] saveState failed:', e.message);
  }
}

function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of obj.codes || []) state.codes.set(k, v);
    for (const [k, v] of obj.pending || []) state.pending.set(k, v);
    for (const [k, v] of obj.counters || []) state.counters.set(k, v);
  } catch (_) { /* 首次启动无状态文件 */ }
}
loadState();

function pruneState() {
  const now = Date.now();
  for (const [k, v] of state.codes) if (v.exp < now) state.codes.delete(k);
  for (const [k, v] of state.pending) if (v < now) state.pending.delete(k);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (const k of state.counters.keys()) if (!k.endsWith(':' + today)) state.counters.delete(k);
}
setInterval(() => { pruneState(); saveState(); }, 60000).unref();

// ---------------------------------------------------------------- 工具
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function hmacSign(payloadB64) {
  return crypto.createHmac('sha256', CFG.SECRET).update(payloadB64).digest('base64url');
}
function timingSafeEq(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    req.on('data', (c) => { data += c; if (data.length > 262144) { over = true; req.destroy(); } });
    req.on('end', () => resolve(over ? null : data));
    req.on('error', () => resolve(null));
  });
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,24}$/;
function normEmail(s) { return String(s || '').trim().toLowerCase(); }

/** 人机验证令牌：本地 HMAC 验签（与 gate/100card 同款） */
function verifyCaptchaToken(token) {
  try {
    if (!CFG.CAPTCHA_SECRET || typeof token !== 'string' || token.length > 1024) return null;
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const mac = crypto.createHmac('sha256', CFG.CAPTCHA_SECRET).update(body).digest('base64url');
    if (!timingSafeEq(mac, sig)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.typ !== 'captcha-pass' || Date.now() > payload.exp) return null;
    return payload;
  } catch (_) { return null; }
}

async function consumeCaptchaToken(token) {
  try {
    const r = await fetch(CFG.CAPTCHA_HUB + '/c/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000),
    });
    const j = await r.json();
    return !!(j && j.ok);
  } catch (_) { return false; } // hub 不可达：拒绝（宁可失败不可放行）
}

// ---------------------------------------------------------------- 极简 SMTP 客户端（STARTTLS）
/**
 * 面向本机 Postfix 的最小 SMTP 会话：
 * 220 → EHLO → STARTTLS → TLS+EHLO → AUTH PLAIN → MAIL → RCPT → DATA → QUIT
 */
function smtpSendMail({ from, to, subject, text, html }) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from('\0' + CFG.SMTP_USER + '\0' + CFG.SMTP_PASS).toString('base64');
    const useTls = CFG.SMTP_TLS !== 'none';
    const cmds = [
      { expect: 220, send: null },                                    // 问候（服务器先开口）
      { expect: 250, send: 'EHLO mail-verify.local' },
    ];
    if (useTls) {
      cmds.push({ expect: 220, send: 'STARTTLS' });
      cmds.push({ expect: 250, send: 'EHLO mail-verify.local', tls: true }); // TLS 内重 EHLO
    }
    cmds.push(
      { expect: 235, send: 'AUTH PLAIN ' + auth },
      { expect: 250, send: 'MAIL FROM:<' + from + '>' },
      { expect: 250, send: 'RCPT TO:<' + to + '>' },
      { expect: 354, send: 'DATA' },
      { expect: 250, send: '__MIME__' },                              // 占位，稍后填充
      { expect: 221, send: 'QUIT' },
    );
    const mime = buildMime({ from, to, subject, text, html, boundary: 'mvb' + crypto.randomBytes(8).toString('hex') });
    const mimeIdx = cmds.findIndex((c) => c.send === '__MIME__');
    cmds[mimeIdx].send = mime.replace(/\r?\n\./g, '\r\n..') + '\r\n.';

    let step = -1;
    let buf = '';
    let socket = net.connect(CFG.SMTP_PORT, CFG.SMTP_HOST);

    const fail = (err) => { try { socket.destroy(); } catch (_) {} reject(err); };
    const timeout = setTimeout(() => fail(new Error('SMTP timeout')), 20000);

    function done() {
      clearTimeout(timeout);
      socket.end();
      resolve();
    }

    /** 收完一个完整应答（末行 line[3] !== '-'）后推进到下一条命令 */
    function sendNext() {
      step += 1;
      const c = cmds[step];
      if (!c) return done();
      if (c.tls) {
        // STARTTLS 应答后：裸 socket 换成 TLS，握手完成才发 EHLO
        const plain = socket;
        plain.removeAllListeners('data');
        socket = tls.connect({ socket: plain, rejectUnauthorized: false }, () => {
          socket.write(c.send + '\r\n');
        });
        socket.on('data', onData);
        socket.on('error', (e) => fail(e));
        return;
      }
      if (c.send !== null) socket.write(c.send + '\r\n');
      // send === null：等服务器先开口（问候）
    }

    function onData(chunk) {
      buf += chunk.toString('binary');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!/^\d{3}[ -]/.test(line)) continue;
        const c = cmds[step];
        if (!c) continue;
        const code = parseInt(line.slice(0, 3), 10);
        if (line[3] === '-') continue; // 多行应答中间行
        if (code !== c.expect) {
          return fail(new Error(`SMTP step ${step} expect ${c.expect} got ${code}: ${line}`));
        }
        sendNext();
      }
    }

    socket.on('data', onData);
    socket.on('error', (e) => fail(e));
    socket.on('close', () => clearTimeout(timeout));
    sendNext();
  });
}

function buildMime({ from, to, subject, text, html, boundary }) {
  const encB64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const encWord = (s) => '=?UTF-8?B?' + encB64(s) + '?=';
  const headers = [
    'From: ' + CFG.FROM_NAME + ' <' + CFG.FROM_EMAIL + '>',
    'To: <' + to + '>',
    'Subject: ' + encWord(subject),
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
  ].join('\r\n');
  const textPart = [
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encB64(text),
  ].join('\r\n');
  const htmlPart = [
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encB64(html),
  ].join('\r\n');
  return headers + '\r\n\r\n' + textPart + '\r\n' + htmlPart + '\r\n--' + boundary + '--\r\n';
}

function codeEmailHtml(code, minutes) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return [
    '<div style="max-width:480px;margin:0 auto;font-family:-apple-system,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;',
    'background:#fafaf8;border:1px solid rgba(0,0,0,.08);border-radius:16px;overflow:hidden">',
    '<div style="background:#c6613f;color:#fff;padding:20px 28px;font-size:18px;font-weight:700">' + esc(CFG.BRAND) + '</div>',
    '<div style="padding:28px;color:#151515;font-size:14px;line-height:1.7">',
    '<p style="margin:0 0 16px">你好，</p>',
    '<p style="margin:0 0 16px">有人在注册时填了这个邮箱。验证码如下（' + minutes + ' 分钟内有效）：</p>',
    '<div style="text-align:center;margin:24px 0"><span style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:8px;',
    'background:#fff;border:1px solid rgba(0,0,0,.1);border-radius:12px;padding:14px 28px">' + code + '</span></div>',
    '<p style="margin:0 0 8px;color:#73726c;font-size:12px">如果这不是你本人的操作，请忽略本邮件，验证码将自动作废。</p>',
    '<p style="margin:0;color:#73726c;font-size:12px">如未收到，请到垃圾邮件文件夹查看。</p>',
    '</div></div>',
  ].join('');
}

// ---------------------------------------------------------------- 接口
function bumpCounter(key, limit) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const k = key + ':' + today;
  const n = (state.counters.get(k) || 0) + 1;
  if (n > limit) return false;
  state.counters.set(k, n);
  return true;
}

async function handleSend(req, res, body) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || '?';
  const email = normEmail(body && body.email);
  const captchaToken = body && body.captchaToken;

  if (!EMAIL_RE.test(email)) return json(res, 400, { error: '邮箱格式不正确' });

  // 限速（先查后扣，失败不占名额）
  const rec = state.codes.get(email);
  const now = Date.now();
  if (rec && rec.lastSent && now - rec.lastSent < CFG.RESEND_COOLDOWN * 1000) {
    const wait = Math.ceil((CFG.RESEND_COOLDOWN * 1000 - (now - rec.lastSent)) / 1000);
    return json(res, 429, { error: `发送太频繁，请 ${wait} 秒后再试`, cooldown: wait });
  }
  if (!bumpCounter('e:' + email, CFG.SEND_PER_EMAIL_DAY)) {
    state.counters.set('e:' + email + ':' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      CFG.SEND_PER_EMAIL_DAY);
    return json(res, 429, { error: '该邮箱今日验证码次数已达上限，请明天再试' });
  }
  if (!bumpCounter('ip:' + ip, CFG.SEND_PER_IP_DAY)) {
    return json(res, 429, { error: '操作过于频繁，请明天再试' });
  }

  // 人机验证：验签 → 烧毁 → 才发信
  if (!verifyCaptchaToken(captchaToken)) return json(res, 400, { error: '请先完成人机验证' });
  const consumed = await consumeCaptchaToken(captchaToken);
  if (!consumed) return json(res, 400, { error: '人机验证已失效，请重新完成验证' });

  // 生成验证码
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const jti = crypto.randomUUID();
  const exp = now + CFG.CODE_TTL * 1000;
  state.codes.set(email, {
    h: crypto.createHmac('sha256', CFG.SECRET).update(code).digest('hex'),
    exp, attempts: 0, jti, lastSent: now,
  });
  saveState();

  const minutes = Math.round(CFG.CODE_TTL / 60);
  const subject = `【${CFG.BRAND}】邮箱验证码 ${code}（${minutes} 分钟内有效）`;
  const text = `你好，\n\n验证码：${code}（${minutes} 分钟内有效）。\n\n如果这不是你本人的操作，请忽略本邮件。\n`;
  try {
    await smtpSendMail({ from: CFG.FROM_EMAIL, to: email, subject, text, html: codeEmailHtml(code, minutes) });
  } catch (e) {
    console.error('[mail-verify] smtp fail:', e.message, 'to=' + email);
    state.codes.delete(email);
    saveState();
    return json(res, 502, { error: '验证码邮件发送失败，请稍后重试' });
  }
  console.log('[mail-verify] sent to=' + email + ' ip=' + ip);
  return json(res, 200, { ok: true, cooldown: CFG.RESEND_COOLDOWN, ttl: CFG.CODE_TTL });
}

function handleVerify(req, res, body) {
  const email = normEmail(body && body.email);
  const code = String((body && body.code) || '').trim();
  const rec = state.codes.get(email);
  if (!rec) return json(res, 400, { error: '请先获取验证码' });
  if (Date.now() > rec.exp) { state.codes.delete(email); saveState(); return json(res, 400, { error: '验证码已过期，请重新获取' }); }
  if (rec.attempts >= CFG.CODE_MAX_ATTEMPTS) { state.codes.delete(email); saveState(); return json(res, 400, { error: '错误次数过多，请重新获取验证码' }); }
  const given = crypto.createHmac('sha256', CFG.SECRET).update(code).digest('hex');
  rec.attempts += 1;
  if (!timingSafeEq(given, rec.h)) {
    saveState();
    const left = CFG.CODE_MAX_ATTEMPTS - rec.attempts;
    return json(res, 400, { error: `验证码不正确（还可尝试 ${left} 次）` });
  }
  // 通过：签发一次性收据
  const iat = Date.now();
  const payload = { v: 1, typ: 'mail-verified', email, jti: rec.jti, iat, exp: iat + CFG.RECEIPT_TTL * 1000 };
  const bodyB64 = b64url(JSON.stringify(payload));
  state.pending.set(rec.jti, payload.exp);
  state.codes.delete(email); // 用过即焚：改邮箱/重发需重新走全流程
  saveState();
  console.log('[mail-verify] verified email=' + email);
  return json(res, 200, { ok: true, receipt: bodyB64 + '.' + hmacSign(bodyB64), email });
}

function handleConsume(req, res, body) {
  const receipt = body && body.receipt;
  try {
    if (typeof receipt !== 'string' || receipt.length > 2048) return json(res, 400, { ok: false });
    const dot = receipt.indexOf('.');
    if (dot < 0) return json(res, 400, { ok: false });
    const bodyB64 = receipt.slice(0, dot);
    if (!timingSafeEq(hmacSign(bodyB64), receipt.slice(dot + 1))) return json(res, 400, { ok: false });
    const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    if (payload.typ !== 'mail-verified' || Date.now() > payload.exp) return json(res, 400, { ok: false });
    if (!state.pending.has(payload.jti)) return json(res, 400, { ok: false, error: '收据已使用或已过期' });
    state.pending.delete(payload.jti);
    saveState();
    return json(res, 200, { ok: true });
  } catch (_) {
    return json(res, 400, { ok: false });
  }
}

// ---------------------------------------------------------------- HTTP 服务
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const seg = urlPath.replace(/\/+$/, '').split('/').pop();
  if (req.method === 'GET' && seg === 'health') {
    return json(res, 200, { ok: true, service: 'portal-mail-verify', time: new Date().toISOString() });
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

  const raw = await readBody(req);
  if (raw === null) return json(res, 413, { error: 'body too large' });
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }

  try {
    if (seg === 'send') return await handleSend(req, res, body);
    if (seg === 'verify') return handleVerify(req, res, body);
    if (seg === 'consume') return handleConsume(req, res, body);
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[mail-verify] handler error:', e);
    return json(res, 500, { error: '服务内部错误' });
  }
});

server.listen(CFG.PORT, CFG.HOST, () => {
  console.log(`[mail-verify] listening on ${CFG.HOST}:${CFG.PORT}, from=${CFG.FROM_NAME} <${CFG.FROM_EMAIL}>`);
});
