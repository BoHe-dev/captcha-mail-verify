# captcha —— 人机验证组件

> Turnstile 风格复选框：无感行为评分直通 + 低分图片点选兜底。纯后端判定，零第三方服务依赖。
> 行为评分底层用 [motion-attestation](https://github.com/libcaptcha/motion-attestation)（行为生物特征）与 [bot-signal](https://github.com/bot-signal/bot-signal)（自动化指纹即时检查），图片挑战用 [go-captcha](https://github.com/wenlng/go-captcha)。

## 工作流程

1. 页面打开即静默采集交互轨迹（鼠标/触摸/键盘节奏，3 秒起步）。
2. 用户点复选框 → `init` → `verify` 提交行为数据，服务端评分。
3. **score ≥ 0.7**（可配）：无感直通，复选框绿色，签发一次性令牌（HMAC，TTL 2 分钟，jti 用前先烧）。
4. **score < 0.7**：弹出图片点选挑战。复选框**锁定**（重复点击/回车/Tab 无效——防止反复触发验证用键盘事件凑判决绕过），点对自动勾选；点错自动换新图（每张图只能校验一次）。
5. 前端另有自动化指纹即时检查（webdriver 等特征），命中一票降分。

## 前端接入（3 行）

```html
<link rel="stylesheet" href="/verify/captcha/assets/widget.css?v=1">
<div data-pcw data-api="/verify/captcha"></div>
<script src="/verify/captcha/assets/widget.js?v=1" defer></script>
```

- `data-api` 指向本站可用的服务前缀（反代到 hub :5111 即可，前缀随意）。
- **版本号 `?v=` 必须带**：改了 assets 不 bump 版本号，浏览器 4 小时内的旧缓存会让老访客跑旧代码。
- 取令牌：

```js
var token = window.PCW.token();          // 无感直通或点选通过后非空
window.PCW.reset();                      // 业务失败后复位复选框
mountEl.addEventListener('pcw:verified', function (e) { token = e.detail.token; });
```

## 后端接入（验签 + 烧毁）

```js
const crypto = require('node:crypto');
const SECRET = process.env.CAPTCHA_SECRET; // 与 hub 共享，≥32 字符

function verifyCaptchaToken(token) {
  try {
    if (!SECRET || typeof token !== 'string' || token.length > 1024) return null;
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sigBuf = Buffer.from(token.slice(dot + 1), 'base64url');
    const mac = crypto.createHmac('sha256', SECRET).update(body).digest();
    if (mac.length !== sigBuf.length || !crypto.timingSafeEqual(mac, sigBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.typ !== 'captcha-pass' || Date.now() > payload.exp) return null;
    return payload; // {v, typ, jti, iat, exp, score}
  } catch (_) { return null; }
}

// 烧毁：验签通过后、执行敏感操作前，回环调 hub（失败宁可拒绝办理）
async function consumeCaptchaToken(token) {
  try {
    const r = await fetch('http://127.0.0.1:5111/c/consume', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }), signal: AbortSignal.timeout(3000),
    });
    return !!(await r.json()).ok;
  } catch (_) { return false; }
}

// 业务里：verifyCaptchaToken 通过 → consumeCaptchaToken 成功 → 才放行
```

## 接口一览

| 接口 | 方法 | 说明 | 限流 |
|---|---|---|---|
| `{prefix}/init` | POST | 签发一次性 cid（2 分钟有效），返回 `{cid, ttl}` | 12/min/IP |
| `{prefix}/verify` | POST | `{cid, d(行为数据), ts, bsi}` → `ok+token` 或 `{challenge:true, ccid}` | 12/min/IP |
| `{prefix}/challenge?ccid=` | GET | 拉图片点选挑战（须携带 verify 签发的 ccid，2 分钟有效） | 10/min/IP |
| `{prefix}/challenge/verify` | POST | `{key, dots[], ccid}` → 通过 `{ok,token}`，**key 一次校验即作废** | 8/min/IP |
| `/c/consume` | POST | `{token}` 烧毁 jti（各应用回环调用） | 仅回环 |
| `{prefix}/assets/*` | GET | 前端静态资产 | — |

- ccid：verify 低分后签发的挑战续接凭证，拉图/校验必须携带、成功即烧毁——堵死跳过行为层直接刷挑战的脚本路径。
- IP 不做硬绑定（移动 NAT 漂移/双栈切换会误伤真人），切换只记日志。
- **自研反代注意**：必须透传查询字符串。`challenge?ccid=xxx` 丢了 `?ccid=` 会被 hub 拒绝，挑战永远弹不出来且无报错。nginx `proxy_pass` 不带 URI 时原样转发无此问题；Flask 写法 `url += '?' + request.query_string.decode('latin-1')`。

## 本文件夹内容

| 文件 | 说明 |
|---|---|
| `server/server.mjs` | hub 服务端（评分/挑战代理/令牌签发烧毁） |
| `server/package.json` | 依赖：motion-attestation、go-captcha-jslib、bot-signal |
| `public/widget.js` / `widget.css` | 复选框组件（状态机/窄屏适配/坐标换算/加载动画） |
| `public/collector.js` | 行为采集器（页面打开即挂） |
| `public/bot-signal.js` | 浏览器自动化指纹即时检查 |
| `public/gocaptcha.global.js/.css` | go-captcha 官方前端组件（MIT，见根目录 NOTICE.md） |
| `DEPLOY.md` | 部署与运维（systemd/nginx/更新/排查） |
| `HARDENING.md` | 渗透测试与加固记录 |

部署步骤见 [DEPLOY.md](DEPLOY.md)。
