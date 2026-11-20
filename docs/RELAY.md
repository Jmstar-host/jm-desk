# 串门中转：部署说明

两台 JM Desk 串门时通过一个中转服务互通。中转只转发**端到端加密**的消息：它看不到内容，也不落盘，重启后自动清空。代码在 `relay/server.mjs`，只依赖 Node 22，不用安装任何第三方库。

## 运行

```bash
PORT=8787 HOST=127.0.0.1 node relay/server.mjs
curl http://127.0.0.1:8787/v1/health   # {"ok":true,"service":"jm-desk-relay"}
```

对外必须放在 **https 反向代理**后面。JM Desk 只接受 https 地址（本机测试时可以用 `http://127.0.0.1`）。以 Caddy 为例，挂在已有域名的一个子路径下：

```
handle_path /jm-desk-relay/* {
    reverse_proxy 127.0.0.1:8787 {
        header_up -Cookie
        header_up -Authorization
    }
}
```

这样中转地址就是 `https://你的域名/jm-desk-relay`。

- **长轮询**：接收消息时，请求最长会挂起 20 秒。反向代理或 CDN 回源的读超时要大于 30 秒。
- **容量**：每个信箱最多保留 50 条消息，每条最多 256 KB，1 小时后过期。好友码 10 分钟内有效，用一次即失效。
- **限流**：按来源 IP 计数。如果前面有代理，转发时要带上 `X-Forwarded-For`。

## 让使用者用上

- **个人**：在「搬运」页填入中转地址。
- **企业**：打包时在预置文件里写 `"relay": "https://…/jm-desk-relay"`（见 `presets/example.integrations.json`），使用者装好就能用。

## 可选：顺便当安装包下载页

启动时加 `DL_DIR=<目录>`（可再加 `DL_KEY=<口令>`、`DL_REPO=<开源仓库 https 地址>`），中转会在 `GET /dl/<口令>/` 提供一个下载页，只列出该目录里的 `.dmg` / `.exe` / `.zip`，只读、不进子目录。没设 `DL_DIR` 时这个功能完全关闭。
下载页按「安装包 / 源码（文件名以 `-source.zip` 结尾）/ 完整包」分区显示；设置了 `DL_REPO` 会在源码区附上仓库链接。
