# 第三方组件

JM Desk 本身以 [MIT](LICENSE) 发布。下面这些组件随源码或安装包一起分发，各自保留原协议：

| 组件 | 位置 | 协议 |
|---|---|---|
| three.js（`three.module.js`，以及 examples 中的 `GLTFLoader.js`、`DRACOLoader.js`、`BufferGeometryUtils.js`） | `app/renderer/vendor/` | MIT，Copyright © 2010-2026 three.js authors |
| Draco 解码器（`draco_decoder.wasm`、`draco_wasm_wrapper.js`） | `app/renderer/vendor/draco/` | Apache-2.0，Copyright © Google LLC |
| Electron | 安装包运行时 | MIT，Copyright © Electron contributors / GitHub Inc. |
| @electron/remote | 安装包依赖 | MIT |

打包工具 electron-builder（MIT）只在构建时使用，不随安装包分发。

形象：随包只带原创的「星灵 Lumi」（代码建模，MIT）。用户自己导入或下载的模型只存在本机数据目录，版权归原作者，不随本项目分发。
