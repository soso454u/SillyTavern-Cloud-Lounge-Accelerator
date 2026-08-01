# 云酒馆加速器 2.0.0

面向云端 SillyTavern 的页面、聊天与界面操作加速器。2.0.0 将原来的开发者式控制台重构成三个自动开关，同时保留 UI 扩展与可选服务端插件的双层架构。

## 2.0.0 的三个功能区

### 页面加载加速

- Service Worker 仅缓存 SillyTavern 程序的 JS、CSS、字体、语言包、图片和声音等静态资源。
- 登录完成且收到 `APP_READY` 后，前端才读取首页 `ETag` / `Last-Modified` 并把版本签名发送给 Worker。
- 当前版本在浏览器空闲、页面可见且网络允许时只自动预热一次。
- 扩展安装、更新、删除、移动或切分支成功后，自动清理程序静态缓存。
- 启动阶段短时间合并完全相同的角色、头像、背景、扩展发现和模板请求。

认证安全规则：

- Worker 不接管任何页面导航，因此不会介入 Basic Auth、登录页或反向代理的原生认证挑战。
- 只缓存 `status === 200`、未重定向且没有 `WWW-Authenticate` / `Proxy-Authenticate` 的同源静态响应。
- `401`、`403`、API、聊天、角色卡、背景、缩略图、用户文件和第三方扩展资源永不进入本插件缓存。
- 所有 Worker 静态网络请求都显式使用 `credentials: "same-origin"`。

### 聊天与重美化优化

- 根据设备能力、消息长度和富组件数量自动选择 8～30 条首屏消息。
- 接近聊天顶部时，自动小批量补载旧消息并保持当前阅读位置。
- 长聊天或复杂美化聊天使用 `content-visibility` 降低屏幕外布局与绘制开销。
- 最近代码优先高亮；旧代码进入视口后再处理，并默认以可点击预览形式折叠。
- 移动端区分横向 Swipe 与纵向滚动，减少误切消息。
- 正则保存、开关、批量操作和拖拽只标记变化；操作完成后合并为一次视口优先的分帧刷新。
- 局部刷新失败时才回退到 SillyTavern 官方完整聊天重载。

### 界面操作优化

- 预设面板先渲染已有内容，Token dry-run 在浏览器空闲时后台更新。
- 预设、正则和世界书共用一套独立的 `PointerEvent + requestAnimationFrame` 拖拽引擎。
- 拖动时只移动轻量影子与插入指示线，松手时才移动一次真实 DOM，并调用 SillyTavern 当前的保存回调。
- 复杂列表内的抽屉使用轻量合成动画，减少逐帧高度计算。
- 所有适配都先做功能检测；接口不可用时保留 SillyTavern 原生行为。

本项目没有加入聊天保存解锁、世界书字段精简、HTML 渲染结果缓存或第三方加速器安装器。

## 最终面板

普通用户只会看到：

```text
云酒馆加速器

● 运行正常

页面加载加速                    [开]
聊天与重美化优化                [开]
界面操作优化                    [开]

[重新渲染当前聊天]

遇到显示异常？
[修复插件]

高级信息 ▸
```

高级信息只显示版本、页面缓存、服务端插件、缓存资源数、聊天优化和界面操作状态，不再暴露帧预算、批量、距离、冷却或缓存范围等内部参数。

## 支持模式

| 安装方式 | 页面静态缓存 | 启动/聊天/正则/交互优化 |
| --- | --- | --- |
| 仅安装 UI 扩展 | 否 | 是 |
| UI 扩展 + 服务端插件 + HTTPS | 是 | 是 |

静态缓存必须使用 HTTPS 或 localhost。纯 UI 模式不要求服务器权限，也不会因服务端插件缺失而报错。

## 推荐：一键安装完整增强

一键安装会把同一仓库安装到 SillyTavern 的 `plugins/cloud-lounge-accelerator` 和默认用户 UI 扩展目录，并备份需要修改的配置。安装后需要手动重启 SillyTavern。

Linux、macOS、1Panel Xterminal：

```bash
cd /path/to/SillyTavern
curl -fsSL https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.sh | bash
```

不在 SillyTavern 根目录时：

```bash
curl -fsSL https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.sh | bash -s -- /path/to/SillyTavern
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.ps1'))) -SillyTavernRoot 'C:\SillyTavern'
```

完整路径判断、更新、卸载、1Panel 和 HTTPS 步骤见 [完整使用教程](docs/完整使用教程.md)。

## 手动安装

### 只安装 UI 扩展

进入 SillyTavern 的“扩展 → 安装扩展”，粘贴：

```text
https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator
```

安装后即可使用启动、聊天、正则与界面操作优化。

### 增加服务端静态缓存

在 SillyTavern 根目录执行：

```bash
git clone https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator.git plugins/cloud-lounge-accelerator
```

已有目录时更新：

```bash
git -C plugins/cloud-lounge-accelerator pull
```

确认 `config.yaml` 中：

```yaml
enableServerPlugins: true
```

然后重启 SillyTavern，并从 HTTPS 域名访问。服务端日志应出现：

```text
Initializing plugin from .../cloud-lounge-accelerator/server/index.js
```

## 1Panel 首访优化

[`1panel/nginx-static.conf.example`](1panel/nginx-static.conf.example) 是只匹配程序静态目录的可选 Nginx 片段。使用前请备份站点配置，把片段放入现有 `server { ... }`，修改 `proxy_pass` 为实际上游，并通过 1Panel 配置检查后再重载。

不要让 Nginx 缓存 `/api/`、登录页、角色卡、聊天、背景或用户文件。

## 更新与修复

升级 2.0.0 后，旧 `1.x` Worker 资源缓存会在激活阶段自动清理。旧设置会迁移为三个开关；旧版曾保存的聊天截断原值会优先恢复，再由自动算法接管当前会话。

遇到样式、Worker 或资源不同步时，打开面板点击“修复插件”。它会：

1. 停止本插件的前端优化模块。
2. 注销本插件的 Worker 并只清理本插件缓存。
3. 重新注册 Worker、读取登录后的版本签名并预热当前资源。
4. 重新启动已开启的三个功能区。

它不会删除聊天、角色卡、世界书、预设或服务器配置。

## 安全与边界

- 服务端插件只提供健康检查和 Service Worker 脚本，不读写用户数据或 SillyTavern 配置。
- 页面缓存只改善第二次及以后访问的静态资源往返，不会缩短 AI 生成时间。
- 第一次访问速度主要依赖服务器、线路、TLS、反向代理和 SillyTavern 本身。
- 如果根作用域已有其他 Service Worker，本插件拒绝覆盖。
- SillyTavern 不应在没有账号、访问控制或可信网络边界时直接暴露到公网。

## 开发检查

```bash
npm test
node --check index.js
node --check server/index.js
```

2.0.0 的交互适配已按 SillyTavern 官方 `release` 分支提交 `8172dcd` 的 PromptManager、正则、世界书和抽屉接口核对。

## 许可证

AGPL-3.0-only。
