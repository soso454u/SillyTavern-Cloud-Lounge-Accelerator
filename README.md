# 云酒馆加速器

面向 **1Panel / Docker / 反向代理部署的 SillyTavern**，专门优化“打开网址到酒馆可用”的重复访问时间。

这个项目是根据 SillyTavern 官方的前端启动顺序、服务端插件路由和静态文件目录独立设计的。

## 它解决什么

SillyTavern 当前的初始化会依次等待 CSRF token、语言包、扩展发现与 manifest、设置、角色库、背景和 tokenizer 等。云服务器叠加 HTTPS 和反代后，大量小 JS/CSS/字体请求的往返时延会被放大。

本项目用两层解决：

1. **浏览器层**：第一次成功进入后，预热这台酒馆实际加载过的核心文件和内置扩展资源。下次先从本地返回，后台同时校验服务器新版本。个人单账号酒馆可在面板中额外开启第三方扩展缓存。
2. **1Panel 反代层**：对真正的程序静态文件开启 gzip 和短时浏览器缓存，改善首次访问。

聊天、角色卡、背景、用户头像、设置、CSRF 和所有生成 API 响应都不会进入 Cache Storage。

## 安装

它同时是 SillyTavern UI 扩展和服务端插件，**同一份仓库需要安装到两个位置**。这是为了不修改 SillyTavern 源文件，也不使用脆弱的 HTML 注入。

> **这不是二选一：第 1 步“服务端插件”和第 2 步“UI 扩展”必须全部完成。** 只安装 UI 扩展时，面板会提示“服务端插件未就绪”；只安装服务端插件时，浏览器不会注册加速服务。第 3 步的 HTTPS 是 Service Worker 的运行条件。

本项目的唯一安装地址是：

```text
https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator
```

### 1. 安装服务端部分

在 1Panel 中进入 SillyTavern 容器终端（或服务器终端），先进入 SillyTavern 根目录，再执行：

```bash
git clone https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator.git plugins/cloud-lounge-accelerator
```

如果该目录已经存在，不要重复 `clone`，更新时使用：

```bash
git -C plugins/cloud-lounge-accelerator pull
```

也可以用 1Panel 文件管理器下载并解压仓库，但最终必须保证整个项目位于：

```text
plugins/cloud-lounge-accelerator/
```

结构应该是：

```text
SillyTavern/
├─ plugins/
│  └─ cloud-lounge-accelerator/
│     ├─ package.json
│     ├─ manifest.json
│     ├─ index.js
│     └─ server/
│        └─ index.js
└─ config.yaml
```

在 SillyTavern 根目录的 `config.yaml` 中，**唯一必须手动确认的配置**是：

```yaml
enableServerPlugins: true
```

这一项无法由插件自动修改：当它是 `false` 时，SillyTavern 根本不会加载任何服务端插件。如果你的文件里已经是 `true`，就不需要再改。

下面是 **可选的官方性能配置**，不是启动本插件的必要条件：

```yaml
performance:
  lazyLoadCharacters: true
  memoryCacheCapacity: '100mb'
  useDiskCache: true

cacheBuster:
  enabled: false
```

> 如果你没有很多角色卡，可以整段不改。角色卡较多时，只把现有的 `lazyLoadCharacters` 改为 `true` 即可。`memoryCacheCapacity: '100mb'`、`useDiskCache: true` 和 `cacheBuster.enabled: false` 在当前 SillyTavern 默认配置中已是推荐值，通常无需修改。不要新建重复的 `performance:` 或 `cacheBuster:` 段。

在 1Panel 重启 SillyTavern 容器/进程。日志中应该出现：

```text
Initializing plugin from .../cloud-lounge-accelerator/server/index.js
```

### 2. 安装 UI 扩展

推荐直接通过 SillyTavern 安装：

1. 进入 SillyTavern 的“扩展”。
2. 选“安装扩展”。
3. 粘贴下面的安装地址并确认：

```text
https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator
```

“通过酒馆粘贴 Git 地址安装”和“手动上传 UI 文件”这两种 UI 安装方式才是二选一。如果不能使用 Git，可把同一份项目手动放到当前用户的扩展目录：

```text
data/<用户>/extensions/cloud-lounge-accelerator/
```

全局扩展的具体目录可能随 SillyTavern 版本和容器映射不同，通过酒馆内的 Git 安装界面最稳妥。

### 3. 确认 HTTPS

Service Worker 只能在 HTTPS 或 localhost 上工作。云酒馆必须用正常域名证书访问，不要用裸 `http://IP:端口`。

完成后，在 1Panel 重启 SillyTavern 容器/进程，然后刷新酒馆页面。打开“扩展设置 → 云酒馆加速器”，状态显示“已启用”即表示两个部分都已正常连接。

## 1Panel 首访优化（可选，推荐）

[`1panel/nginx-static.conf.example`](1panel/nginx-static.conf.example) 是一份只命中程序静态目录的 Nginx 片段。

1. 先在 1Panel 备份当前网站配置。
2. 打开“网站 → 配置 → 配置文件”。
3. 把片段放入已有的 `server { ... }` 内。
4. 把片段中的 `proxy_pass http://127.0.0.1:8000;` 改成你现有 SillyTavern 反代使用的上游。
5. 用 1Panel 的配置检查通过后再重载 OpenResty/Nginx。

如已经存在同样的正则 `location`，不要直接叠加；把 `gzip`、`proxy_hide_header`、`expires` 和 `add_header` 合并进原规则。

## 使用

安装后打开“扩展设置 → 云酒馆加速器”：

- **启用本地加速**：注册/卸载本项目的 Service Worker。
- **自动预热当前安装**：根据当前页面真实加载记录预热，不猜测你安装了什么。
- **缓存第三方扩展**：默认关闭。如这是你一个人使用的单账号云酒馆，可开启来减少扩展文件往返；多账号共用同一域名时保持关闭，避免账号间复用同路径文件。
- **立即预热**：新安装一批扩展后可手动执行。
- **清空并重建**：遇到样式/扩展文件不同步时使用。

面板会显示 TTFB、DOM 可交互时间、首页传输量、HTTP 协议和当前 Worker 生命周期的本地命中数。

## 更新安全

- 根页面每次都走网络，不离线缓存 HTML，因此登录跳转不会被古老页面拦住。
- 根页面的 `ETag` 或 `Last-Modified` 变化时，会在任何 JS/CSS 执行前废弃旧资源缓存。
- SillyTavern 扩展安装、更新、删除、移动或切分支成功后，会自动失效程序资源缓存。API 响应本身不被缓存。
- 如站点根路径已存在其他 Service Worker，本项目会拒绝覆盖并在面板报错。

## 效果边界

能明显改善的是第二次及以后访问中，核心脚本、样式、字体、语言包和扩展文件带来的多次跨网往返。

它不会缩短：

- AI 接口的生成时间。
- 第一次访问时的完整网络下载（需依靠 1Panel/CDN 层改善）。
- `/api/settings/get`、`/api/characters/all` 等动态初始化的服务器处理时间；其中角色库已通过官方 `performance.lazyLoadCharacters` 设置针对。
- 浏览器主动清除站点数据、无痕窗口或 iOS 因存储压力回收缓存后的重新预热。

## 排查

**面板显示“服务端插件未就绪”**

- 确认项目在 `plugins/cloud-lounge-accelerator/` 而不是只安装了 UI 扩展。
- 确认 `enableServerPlugins: true`。
- 重启 SillyTavern，而不是只重载 Nginx。
- 查看 SillyTavern 容器日志的 `Plugin loading failed` / `Failed to load plugin`。

**面板显示“需要 HTTPS”**

- 从 `https://你的域名` 进入，确认证书无错误。
- 确认 1Panel 反代传递 `X-Forwarded-Proto $scheme`。

**第二次还是慢**

1. 看面板的“已启用 · N 个本地资源”；`N = 0` 时点“立即预热”。
2. TTFB 高：先查 1Panel 反代、TLS、云服务器区域和线路。
3. TTFB 低但 DOM 可交互很高：通常是角色/扩展太多，先启用 `lazyLoadCharacters`，再暂停不必要的大型扩展做 A/B 比较。
4. 协议显示 `http/1.1`：检查 1Panel 站点是否对外启用 HTTP/2（或 HTTP/3）。

## 安全

SillyTavern 官方不建议把实例无额外保护地直接暴露在公网。即使使用 1Panel HTTPS，也建议叠加 SillyTavern 账号登录以及 Cloudflare Access、Tailscale 或其他可信访问层。

服务端插件不受 SillyTavern 沙箱保护。本项目的服务端部分不读写用户数据或配置，只提供一个健康检查 JSON 和一个带根作用域授权的 Worker 脚本。

## 开发检查

```bash
npm test
node --check index.js
node --check server/index.js
```

当前按 SillyTavern `release` 1.18.0 源码的启动链路和插件接口开发。

## 许可证

AGPL-3.0-only。
