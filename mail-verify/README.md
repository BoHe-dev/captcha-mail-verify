# mail-verify —— 邮箱验证码组件

> 注册流程的"邮箱验证码"环节：6 位数字码发到用户邮箱，验证通过签发一次性收据，业务后端验签烧毁后才建号。
> 发信走你自己的 SMTP（本机 Postfix 或任意中继），零第三方服务依赖。
> 与 [captcha/](../captcha/README.md) 人机验证组件联动：发送验证码前必须先过人机验证，双重门槛。

## 工作流程

```
用户输入邮箱 → 点「发送验证码」
   ├─ 前端先取人机验证令牌（没过人机验证按钮是禁用的）
   ├─ POST /send {email, captchaToken}
   │    服务端：令牌验签 + 烧毁 → 同邮箱 60s 冷却/10 次·天 → 同 IP 20 次·天
   │    → 6 位数字码（HMAC 存储，10 分钟有效，最多 5 次尝试）→ SMTP 发信
   ← 用户收到邮件，输入验证码
   ├─ POST /verify {email, code} → 通过签发一次性收据 receipt（HMAC，15 分钟有效）
   └─ 注册提交：{receipt, email} 随表单上送
        后端：验签 receipt + 回环调 /consume 烧毁（jti 一次性）→ 建号
```

安全设计：

- 验证码不落库明文，存 HMAC；最多 5 次尝试。
- 发送限速：同邮箱 60 秒冷却、10 次/天；同 IP 20 次/天——防轰炸、防枚举。
- 收据（receipt）一次性，先烧毁后建号；服务不可达时宁可拒绝注册也不放行。
- 状态持久化（原子写），服务重启不丢冷却计时和收据。

## 前端接入（2 行 + 几行胶水）

```html
<div id="mvMount"></div>
<script src="/verify/mailv/assets/mailverify-widget.js?v=1" defer></script>
<script>
// widget 带 defer，等它就位后再挂
(window.readyState === 'complete')
  ? bootMV()
  : window.addEventListener('load', bootMV);

function bootMV() {
  MailVerify.mount(document.getElementById('mvMount'), {
    api: '/verify/mailv',                // 本站反代到 mail-verify 的前缀
    getCaptchaToken: function () { return (window.PCW && PCW.token()) || ''; },
    captchaMount: document.querySelector('[data-pcw]'),   // 人机验证挂载点（联动启停，可选）
    onCaptchaConsumed: function () { window.PCW && PCW.reset(); },  // 发信已烧令牌，复位人机验证
    onNeedCaptcha: function () { /* 高亮人机验证区 */ },
    onCaptchaFail: function () { window.PCW && PCW.reset(); },
    rightHint: '没有邮箱？可以使用任意常用邮箱',   // 可自定义
  });
}

// 注册提交时：
var r = await MailVerify.verify();       // → {ok:true, receipt, email} 或 {ok:false, error}
// 把 r.receipt 与 r.email 随注册表单上送
</script>
```

组件零依赖、样式自注入，通过 CSS 变量（`--mvw-accent`、`--mvw-input-bg` 等）适配页面主题。

## 后端接入

mail-verify 服务端（`server/server.mjs`）零 npm 依赖（node:crypto/net/tls 直接发 SMTP）。

### 1. 本地验签收据（与 captcha 令牌同款模式）

```js
const crypto = require('node:crypto');
const SECRET = process.env.MAILV_SECRET;   // 与 mail-verify 服务共享

function verifyReceipt(receipt) {
  try {
    if (!SECRET || typeof receipt !== 'string' || receipt.length > 1024) return null;
    const dot = receipt.indexOf('.');
    if (dot < 0) return null;
    const body = receipt.slice(0, dot);
    const sigBuf = Buffer.from(receipt.slice(dot + 1), 'base64url');
    const mac = crypto.createHmac('sha256', SECRET).update(body).digest();
    if (mac.length !== sigBuf.length || !crypto.timingSafeEqual(mac, sigBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.typ !== 'mail-verified' || Date.now() > payload.exp) return null;
    return payload; // {typ, jti, email, iat, exp}
  } catch (_) { return null; }
}
```

### 2. 烧毁收据（回环调 mail-verify）

```js
async function consumeReceipt(receipt) {
  try {
    const r = await fetch('http://127.0.0.1:5113/consume', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receipt }), signal: AbortSignal.timeout(3000),
    });
    return !!(await r.json()).ok;
  } catch (_) { return false; }
}

// 注册接口里：verifyReceipt 通过 → consumeReceipt 成功 → 才建号
```

### 3. 直接不用组件前端的情况

也可以完全自己写 UI，只调三个接口：`/send`、`/verify`、`/consume`（见下表）。

## 接口一览

| 接口 | 方法 | 请求 | 响应 |
|---|---|---|---|
| `{prefix}/send` | POST | `{email, captchaToken}` | `{ok:true}`（已发信）或 4xx + error |
| `{prefix}/verify` | POST | `{email, code}` | `{ok:true, receipt, email}` |
| `{prefix}/consume` | POST | `{receipt}` | `{ok:true}` |
| `{prefix}/health` | GET | — | `{ok:true}` |

路由前缀自适应：`/api/mailv/*`、`/mailv/*`、`/v/*` 都能识别（按最后一个段匹配），各站反代时用任意前缀都行。

## 服务端配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAILV_SECRET` | 无（必填，≥32 字符否则拒绝启动） | 收据/验证码 HMAC 密钥 |
| `PORT` / `MAILV_HOST` | 5113 / 127.0.0.1 | 监听 |
| `PORTAL_CAPTCHA_SECRET` | 无 | 人机验证 hub 的共享密钥（验签 captchaToken 用） |
| `CAPTCHA_HUB` | `http://127.0.0.1:5111` | captcha hub 地址（烧毁令牌用） |
| `MAILV_SMTP_HOST` / `MAILV_SMTP_PORT` | 127.0.0.1 / 587 | 发信 SMTP |
| `MAILV_SMTP_TLS` | starttls | `starttls` 或 `none`（25 端口明文/测试） |
| `MAILV_SMTP_USER` / `MAILV_SMTP_PASS` | 空 | SMTP 认证（不需要则留空） |
| `MAILV_FROM_EMAIL` / `MAILV_FROM_NAME` | SMTP 用户 / MailVerify | 发件人 |
| `MAILV_BRAND` | MailVerify | 邮件模板里的品牌名 |
| `MAILV_CODE_TTL` / `MAILV_CODE_MAX_ATTEMPTS` | 600 秒 / 5 次 | 验证码有效期与尝试上限 |
| `MAILV_RESEND_COOLDOWN` | 60 秒 | 同邮箱重发冷却 |
| `MAILV_SEND_PER_EMAIL_DAY` / `MAILV_SEND_PER_IP_DAY` | 10 / 20 | 每日发送上限 |
| `MAILV_RECEIPT_TTL` | 900 秒 | 收据有效期 |
| `MAILV_STATE_DIR` | /var/lib/mail-verify | 状态持久化目录 |

## system d 部署示例

```ini
[Unit]
Description=Mail Verify (email verification code, loopback only)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/mail-verify
EnvironmentFile=/etc/verify-suite.env
ExecStart=/usr/bin/node /srv/mail-verify/server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

反向代理与"查询字符串透传"注意事项见 [captcha/DEPLOY.md](../captcha/DEPLOY.md) 第五节（两个组件的反代要求完全一致）。

## 本文件夹内容

| 文件 | 说明 |
|---|---|
| `server/server.mjs` | 验证码服务端（发信/校验/收据/限速/持久化，零依赖） |
| `public/mailverify-widget.js` | 前端组件（邮箱输入 + 发送倒计时 + 验证码输入，零依赖） |
