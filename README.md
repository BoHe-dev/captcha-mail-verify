# captcha-mail-verify

自托管的两件验证组件，给个人网站/小项目补上注册环节的防线：

- **captcha/** —— 人机验证：Turnstile 风格复选框。打开页面就开始采集鼠标轨迹和键盘节奏，服务端算行为分，分数够高直接放行；分数低就弹出图片点选挑战。纯后端判定，前端只负责采集。
- **mail-verify/** —— 邮箱验证码：6 位数字码发到邮箱，HMAC 存储、限次限速、一次性收据，防枚举防轰炸。

两个组件都是**零第三方服务依赖**：不需要 Turnstile/hCaptcha 的账号和密钥，邮件走你自己的 SMTP，所有数据留在你服务器上。适合不想把验证环节交给别人的自托管场景。

行为评分和图片挑战的底层分别用了 [motion-attestation](https://github.com/libcaptcha/motion-attestation)、[bot-signal](https://github.com/bot-signal/bot-signal) 和 [go-captcha](https://github.com/wenlng/go-captcha)，站在这些项目的肩膀上做了封装和加固，感谢原作者（MIT，声明见 [NOTICE.md](NOTICE.md)）。

## 架构

```
浏览器                                你的服务器（仅回环，公网不可直连）
┌──────────────────────┐             ┌─────────────────────────────┐
│ widget.js            │  反代(任意前缀) │ captcha hub :5111            │──→ go-captcha :5112
│ 复选框 + 行为采集      │ ──────────→ │ 行为评分 → 签发一次性令牌      │    (图片点选生成/校验)
└──────────────────────┘             └─────────────────────────────┘
        │
        │ 拿到令牌后才能发验证码
        ↓
┌──────────────────────┐             ┌─────────────────────────────┐
│ mailverify-widget.js │ ──────────→ │ mail-verify :5113            │──→ SMTP (Postfix 等)
│ 邮箱输入 + 验证码      │             │ 限速限次 → 发信 → 一次性收据   │
└──────────────────────┘             └─────────────────────────────┘
```

设计要点：

- **先人机验证，后发码**：邮件验证码的发送按钮联动人机验证令牌，没过人机验证就发不了码——注册接口最难被脚本打的那个环节（发信）被挡在双重门槛后面。
- **一次性令牌/收据**：HMAC 签名 + jti 烧毁，验签通过不等于能用，用前先烧。
- **失败也安全**：任何一环不可达，后端宁可拒绝办理也不放行。

## 快速开始

两个组件各自独立，可以只用其中一个。详细步骤看各自文件夹里的 README：

| 组件 | 文档 | 接入工作量 |
|---|---|---|
| [captcha/](captcha/README.md) | 前端 3 行 HTML + 后端约 30 行验签烧毁代码 | ~15 分钟 |
| [mail-verify/](mail-verify/README.md) | 前端 2 行 HTML + 后端复用同一套验签模式 | ~15 分钟 |

最简部署：一台 Linux 机器 + Node 18+（captcha 还需要一个 go-captcha 服务，二进制开箱即用）。完整的服务端配置、systemd、nginx 反代和故障排查写在 [captcha/DEPLOY.md](captcha/DEPLOY.md) 和 [mail-verify/README.md](mail-verify/README.md)。

## 环境要求

- Node 18+（零 npm 依赖，node:crypto 就够）
- 一个能发信的 SMTP（本机 Postfix 或任意中继，mail-verify 用）
- 反向代理（nginx / caddy / 自研均可，把对外前缀转回环端口）

## 目录结构

```
├── captcha/            人机验证组件
│   ├── server/         hub 服务端（评分/挑战代理/令牌签发烧毁）
│   ├── public/         前端资产（widget/采集器/指纹检查/go-captcha 前端组件）
│   ├── README.md       接入文档（前端/后端/接口表/新站接入清单）
│   ├── DEPLOY.md       部署与运维
│   └── HARDENING.md    渗透测试与加固记录
├── mail-verify/        邮箱验证码组件
│   ├── server/         验证码服务端（发信/校验/收据/限速）
│   ├── public/         前端组件
│   └── README.md       接入文档
├── LICENSE             MIT
└── NOTICE.md           上游项目声明
```

## License

本项目代码以 [MIT](LICENSE) 发布。内含/依赖的上游库各有其许可证与版权，见 [NOTICE.md](NOTICE.md)。
