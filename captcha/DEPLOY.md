# 部署与运维

> 目标机器：任意 Linux x64/ARM64 + Node 18+。示例统一用 `/srv/captcha` 作安装目录，可自行替换。

## 一、服务与端口

| 服务 | 端口 | 作用 |
|---|---|---|
| captcha hub（本组件） | 127.0.0.1:5111 | 评分、挑战代理、令牌签发/烧毁、静态资产 |
| [go-captcha](https://github.com/wenlng/go-captcha) | 127.0.0.1:5112 | 图片点选生成/校验（官方二进制，仅被 hub 调用） |

两个服务都只监听回环，公网通过反向代理访问。

## 二、安装

```bash
# 1. 目录
sudo mkdir -p /srv/captcha && sudo chown $USER /srv/captcha
scp -r captcha/server/* user@server:/srv/captcha/
cd /srv/captcha && npm install

# 2. go-captcha：从官方 release 下载对应架构的二进制
#    https://github.com/wenlng/go-captcha-service/releases
#    解压后放到 /srv/gocaptcha/，按官方说明准备 config

# 3. 密钥（≥32 字符，用 openssl rand -base64 32 生成）
echo "CAPTCHA_SECRET=$(openssl rand -base64 32)" | sudo tee /etc/verify-suite.env
sudo chmod 600 /etc/verify-suite.env
```

## 三、systemd

`/etc/systemd/system/captcha-hub.service`：

```ini
[Unit]
Description=Captcha Hub (human verification, loopback only)
After=network.target gocaptcha.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/captcha
EnvironmentFile=/etc/verify-suite.env
ExecStart=/usr/bin/node /srv/captcha/server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/srv/captcha

[Install]
WantedBy=multi-user.target
```

go-captcha 同理写一个 unit（`After=network.target`），跑在 127.0.0.1:5112。

## 四、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CAPTCHA_SECRET` | 无（必填，≥32 字符否则拒绝启动） | HMAC 共享密钥，所有验签后端共用 |
| `PORT` | 5111 | 监听端口 |
| `CAPTCHA_SCORE_PASS` | 0.7 | 无感直通线（0.5~0.9 之间调，越高越严） |
| `GOCAP_BASE` | `http://127.0.0.1:5112/api/v1/public` | go-captcha 上游地址 |
| `CAPTCHA_CHALLENGE_ID` | `click-shape-default` | 挑战形状集 |
| `CAPTCHA_TOKEN_TTL_MINUTES` | 1440 | 令牌有效期（分钟），默认 24 小时——提前验证后慢慢填表不会让勾失效 |

## 五、反向代理

nginx 示例（`proxy_pass` 不带 URI → 原样转发前缀，包括查询字符串）：

```nginx
upstream captcha_hub { server 127.0.0.1:5111; }

location ^~ /verify/captcha/ {
    client_max_body_size 256k;   # verify 上传行为数据（几十 KB 量级）
    proxy_pass http://captcha_hub;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> **自研反代（Flask/Node 等）必须透传查询字符串**：`challenge?ccid=xxx` 丢了 `?ccid=` 会被 hub 拒绝，图片挑战永远弹不出来且无报错。这是真实踩过的坑。
> Flask：`url += '?' + request.query_string.decode('latin-1')`。

## 六、更新流程

1. 改工作区源码 → scp/rsync 到服务器（资产目录应用用户可写）。
2. **改了 server.mjs** → `sudo systemctl restart captcha-hub`；只改 `public/` 静态资产 → 不用重启。
3. **bump 版本号**：所有引用页面里 `widget.js?v=`、`widget.css?v=` 同步 +1。**漏这步 = 老访客跑浏览器缓存里的旧代码**（浏览器缓存资产最长可达数小时，CF 等还会放大）。
4. 新增依赖：服务器上 `npm install`。

## 七、排查速查

```bash
systemctl status captcha-hub
journalctl -u captcha-hub -n 50 --no-pager    # 评分、挑战校验、ip-switch 日志
curl -s http://127.0.0.1:5111/api/captcha/assets/widget.js -o /dev/null -w '%{http_code}\n'
```

| 症状 | 原因与处理 |
|---|---|
| 服务起不来 `CAPTCHA_SECRET ... 拒绝启动` | env 未注入或密钥 <32 字符 |
| 复选框报"服务暂不可用" | hub 挂了 / 反代不通 / 浏览器跑了旧 widget.js（bump 版本号） |
| 图片挑战不弹出 | 旧版 widget（bump）；ccid 过期（2 分钟，重走）；**反代丢了查询字符串**（见第五节） |
| 怎么点都"点选不正确" | 旧版 widget 无坐标换算（本仓库版本已内置；老缓存的资产 bump 掉） |
| 点错后图不变、刷新无效 | 同上，旧版资产 |
| 被限流 429 | 12/min/IP 等阈值触发；测试机与真实用户共享出口 IP 时注意 |

## 八、安全设计小结

- 所有服务仅监听回环，公网只能走反代。
- 令牌 HMAC 签名、TTL 2 分钟、jti 一次性（用前先烧毁，验签通过 ≠ 可用）。
- ccid 一次性 + 成功即烧毁，堵死跳过行为层直接刷挑战的路径。
- 行为评分在后端做，前端只是采集器——改前端提交假数据没有用。
- 限流按 IP 维度多层设置（init/verify/challenge/校验各自独立）。
