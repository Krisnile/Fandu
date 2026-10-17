<p align="center"><img src="build/icon.svg" width="96" alt="Fandu icon"></p>

# 番渡 · Fandu

A local-first anime and media tracker with a clean interface, customizable themes, and automatic saving.

番渡是一款本地优先的作品收藏与观看进度管理工具。把动画、电影、剧集与其他作品整理在一起，让记录轻一点，让收藏有自己的样子。

[下载安装](https://github.com/Krisnile/Fandu/releases/latest) · [使用与开发](DEVELOPMENT.md) · [更新记录](CHANGELOG.md) · [问题反馈](https://github.com/Krisnile/Fandu/issues)

## 特点

- **简洁的收藏页**：封面与标题优先，悬停或键盘聚焦后呈现更多信息，支持网格、列表、筛选、排序和批量整理。
- **完整的个人记录**：观看状态、集数进度、评分、笔记、自定义列表、标签与系列归类。
- **多来源查找**：聚合公开资料来源，优先显示本地匹配；来源故障分别提示，也可以手动添加作品。
- **自己的配色**：五套预设、深浅模式与自定义主题色；日常编辑和外观调整自动保存，无需额外点击保存。
- **数据留在本地**：文件持久化、自动备份、手动快照、封面缓存，以及带校验的完整迁移包。
- **面向恢复的保存机制**：保存失败和冲突明确提示，提供草稿与未完成操作的恢复入口，不把未知结果当作成功。

本项目是资料与进度管理器，**不提供视频播放、盗版资源或影视下载**。联网搜索、元数据与封面获取仍需要网络，资料可用性取决于第三方来源。

## 下载与安装

在 [Releases](https://github.com/Krisnile/Fandu/releases) 下载对应安装包，无需安装 Node.js。

| 平台 | 系统要求 | 安装包 |
| --- | --- | --- |
| macOS · Apple Silicon | macOS 13 或更新版本 | `Fandu-0.3.3-macOS-arm64.dmg`，或同名 ZIP 便携包 |
| Windows · x64 / ARM64 | 64 位 Windows 10 或更新版本 | `Fandu-0.3.3-Windows-Setup.exe`，同一安装器包含两种架构 |

macOS 打开 DMG 后，将番渡拖入“应用程序”；Windows 运行 EXE 并按安装向导操作。目前没有 Intel Mac 或 Linux 安装包。

**当前安装包未签名／未公证，系统可能显示安全提示；请仅从本仓库下载并核对随包提供的 SHA-256 校验值。** macOS 遇到拦截时，可在确认来源后通过系统“隐私与安全性”允许打开，无需关闭系统安全防护。

Mac 版已有本机运行验证；**Windows 安装包已生成，但尚未完成 Windows 原生实测**。当前不提供自动更新，请备份后手动下载新版。

## 从源码运行

仅使用网页模式需要 **Node.js 22.9+**，无需安装第三方依赖：

```sh
git clone https://github.com/Krisnile/Fandu.git
cd Fandu
npm start
```

访问 [http://127.0.0.1:4173](http://127.0.0.1:4173)，在终端按 Ctrl+C 停止。开发时可使用 `npm run dev`。

桌面开发需要 **Node.js 22.12+**（建议使用 Node.js 24）：

```sh
npm ci
npm run desktop
```

首次安装会下载 Electron。桌面版自行启动本地服务，不需要再运行 `npm start`。

## 数据与备份

| 运行方式 | 默认资料目录 |
| --- | --- |
| 网页模式 | 项目下的 `data/` |
| macOS 桌面版 | `~/Library/Application Support/Fandu/data/` |
| Windows 桌面版 | `%APPDATA%/Fandu/data/` |

“关于”页可查看实际数据位置。网页模式可以参考 [`.env.example`](.env.example) 设置 `FANDU_DATA_DIR`；桌面版使用独立用户目录，不自动读取网页收藏库。

迁移电脑或从网页版转到桌面版时，在设置的“备份”中导出**完整迁移包**，再到目标实例导入。迁移包包含已保存资料、设置和离线封面；尚未提交的录入草稿与浏览器恢复记录不在其中，请先处理。建议把备份另存到其他磁盘。

数据文件保存在本机，**不等于加密**。当前面向单人本地使用，没有账号或云同步；联网查找会向所选来源发送搜索词，获取封面时也会访问相应服务。

## 项目结构

```text
desktop/       Electron 主进程与桌面安全策略
lib/           本地存储、来源适配、备份与校验
src/           原生 JavaScript 页面与交互
scripts/       可选开发及回归检查脚本
test/          Node.js 自动化测试
build/         桌面图标与安装器配置
docs/          发布说明
data/          本地用户资料（不提交）
dist/          构建产物（不提交，安装包见 Releases）
```

## 参与项目

欢迎通过 [Issues](https://github.com/Krisnile/Fandu/issues) 反馈问题与建议，也欢迎提交 Pull Request。请先阅读 [贡献指南](CONTRIBUTING.md)；安全问题请参考 [安全说明](SECURITY.md)。

项目由 [Krisnile](https://github.com/Krisnile) 维护，使用 OpenAI Codex 辅助开发与整理，详见 [致谢](ACKNOWLEDGMENTS.md)。

## 许可证

项目代码采用 [MIT License](LICENSE)。第三方依赖遵循各自许可证；外部资料、封面、商标与作品版权归相应权利人所有，不因本项目开源而改变。
