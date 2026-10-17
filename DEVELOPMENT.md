# 开发指南

番渡使用原生 HTML/CSS/JavaScript、Node.js 本地服务和 Electron 桌面外壳，无前端构建步骤。

## 常用命令

```sh
npm start                 # 网页版，默认 127.0.0.1:4173
npm run dev               # Node 服务自动重启；前端修改后刷新页面
npm test                  # Node.js 单元与集成测试
npm ci                    # 安装锁定的桌面开发依赖
npm run desktop           # 启动桌面开发版
npm run desktop:pack      # 当前平台的未安装应用目录
npm run desktop:dist -- --mac --arm64
npm run desktop:dist -- --win
```

网页模式需要 Node.js 22.9+；桌面开发需要 22.12+，建议使用 Node.js 24。构建输出在 `dist/`。macOS 安装包应在 Mac 上构建；Windows 打包是否可交叉构建取决于宿主工具链，建议在 Windows 上构建并完成原生验证。当前配置仅支持 Mac / Windows，没有 Linux 发布目标。

构建默认不签名、不公证、不自动上传。公开分发前请检查平台要求；不要将签名证书、令牌、`.env` 或个人 `data/` 加入仓库。

## 数据隔离

- 网页模式：`.env` 中的 `FANDU_DATA_DIR` 指定资料目录；相对路径基于项目根目录解析。
- 桌面模式：`FANDU_DESKTOP_PROFILE` 必须为绝对路径，用于独立桌面配置目录，资料位于其 `data/` 子目录。桌面模式不使用网页的默认资料目录。
- 普通测试使用临时目录，不要把真实收藏复制到测试夹具或提交到仓库。
- `.local/` 保留本机内部记录、历史截图和一次性维护脚本，默认忽略，不属于发布源码。

## 模块边界

`server.mjs` 提供本地 HTTP 接口；`lib/` 负责档案、来源与备份；`src/` 负责页面、状态和恢复交互；`desktop/` 处理固定应用地址、窗口、安全隔离与退出协调。修改存储协议时，应同时考虑服务端写入结果、客户端保存队列、草稿恢复和导入兼容性。

桌面渲染进程不开放 Node.js，外部页面不在应用窗口中运行。本地服务只监听回环地址；不要为方便调试而移除访问校验、沙箱或数据版本检查。

## 按需检查

优先运行与改动相关的 Node 测试，例如：

```sh
node --test test/desktop-policy.test.mjs
```

可选 UI / Electron 回归脚本位于 `scripts/`，不要求每次修改都运行。需要本地安装 Playwright（`npm install --no-save --package-lock=false playwright`），网页脚本通常还需要已安装的 Google Chrome；也可以通过 `PLAYWRIGHT_MODULE` 指定可导入的 Playwright 模块。不要提交因此生成的依赖变更和截图。

`npm run qa:desktop` 检查独立临时桌面配置；`node scripts/desktop-qa.mjs --packaged` 的默认目标是 Mac ARM64 包，其他目标需用绝对路径环境变量 `FANDU_QA_EXECUTABLE` 指定。打包成功不等于跨平台原生验收。

`npm run qa:library` 是可选的本机收藏检查，输出可能包含个人资料，不应放进公共 Issue 或提交。

## 精简发布

1. 更新版本、变更记录和 `docs/releases/` 下的说明。
2. 只运行涉及改动的关键检查，确认源码不含个人资料与密钥。
3. 构建或选用已核对的对应版本安装包，计算 SHA-256，标注平台验证范围和签名状态。
4. 提交源码、创建版本标签，在 GitHub Releases 上传安装包、校验清单与许可证。

不要求复杂的 CI、自动更新服务或签名基础设施。Release 应准确说明已知限制，不应把未验证平台写成“已全面验证”。
