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

### 用下载目录做应用内升级

把 `latest.json`（`cd app && npm run release -- --notes "更新点"` 生成，在 `dist/` 里）和它列出的安装包一起放进 `DL_DIR`，升级地址就是：

```
https://<中转地址>/dl/<口令>/latest.json
```

- 打包时把这个地址写进预置文件顶层的 `update`（见 AGENTS.md §8），装了这个包的 JM Desk 会自己来读：启动后 15 秒、每 6 小时、电脑唤醒或解锁时。发现新版本就提示，下载同目录的安装包并校验 sha256。
- `latest.json` 不缓存、不出现在下载页的文件列表里；下载页顶部会显示它里面的当前版本和更新点。内容不是合法 JSON 时返回 404，不会把坏文件发给客户端。
- 发新版本只要往 `DL_DIR` 放新的安装包、覆盖 `latest.json`，不用重启中转。
- **MOD 库**（1.8.4）：在 `DL_DIR` 下建 `mods/`，放清单 `index.json` 和 `.glb` 模型（文件名小写字母、数字、`.`、`_`、`-`），地址是 `https://<中转地址>/dl/<口令>/mods/index.json`，写进企业预置文件顶层的 `mods`。清单格式和第一批星灵配色见 `presets/mods/index.json`。加形象只要放文件、改清单，不用重启；客户端最多 5 分钟后看到。只放原创或许可允许分发的形象。先放安装包，最后覆盖 `latest.json`，免得客户端读到新版本号却下不到包。
- 升级地址为空的旧安装包（1.1.x）不会来读，这些用户要从下载页手动装一次。
下载页按「安装包 / 源码（文件名以 `-source.zip` 结尾）/ 完整包」分区显示；设置了 `DL_REPO` 会在源码区附上仓库链接。
