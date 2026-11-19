# NOTICE — 第三方组件声明

本仓库封装并分发以下第三方库的官方构建产物（或直接依赖），它们都是他人的 MIT 许可作品，版权与许可声明如下，请勿移除。

## 1. motion-attestation

- 来源：<https://github.com/libcaptcha/motion-attestation>
- 许可证：MIT（Copyright (c) 2026 libcaptcha）
- 用途：行为生物特征评分（鼠标轨迹/键盘节奏/触摸动力学的服务端分析），本仓库 `captcha/server/` 通过 npm 依赖引入；`captcha/public/collector.js` 为其官方浏览器端采集器构建产物。

## 2. bot-signal

- 来源：<https://github.com/bot-signal/bot-signal>
- 许可证：MIT
- 用途：浏览器自动化指纹即时检查（webdriver 等特征一票降分），`captcha/public/bot-signal.js` 为其官方浏览器端构建产物。

## 3. go-captcha-jslib

- 来源：<https://github.com/wenlng/go-captcha-jslib>
- 许可证：MIT
- 用途：图片点选挑战的前端交互组件，`captcha/public/gocaptcha.global.js` / `gocaptcha.global.css` 为其官方全局构建产物。

## 4. go-captcha（服务端，不随本仓库分发）

- 来源：<https://github.com/wenlng/go-captcha>
- 许可证：Apache-2.0
- 用途：图片点选挑战的生成与校验服务。部署时需按其官方 release 单独下载二进制，本仓库不包含、不修改其代码。

以上项目与本仓库相互独立，本仓库的封装部分不代表原作者观点。使用中如遇这些上游库的问题，请优先到其各自仓库反馈。
