# 云酒馆加速器

面向 **1Panel / Docker / 反向代理部署的 SillyTavern**，专门优化“打开网址到酒馆可用”的重复访问时间。

这个项目是根据 SillyTavern 官方的前端启动顺序、服务端插件路由和静态文件目录独立设计的。

## 它解决什么

SillyTavern 当前的初始化会依次等待 CSRF token、语言包、扩展发现与 manifest、设置、角色库、背景和 tokenizer 等。云服务器叠加 HTTPS 和反代后，大量小 JS/CSS/字体请求的往返时延会被放大。

本项目用两层解决，而且两层可以独立使用：

1. **纯 UI 前端层**：默认开启 1.5.0 全局前端接管，通过统一帧预算调度启动预取、正则合并刷新、自适应首屏、顶部旧消息补载、聊天局部高亮与移动端滑动保护。只在 SillyTavern 内安装 UI 扩展即可使用，不需要服务器权限或 HTTPS。
2. **可选服务端增强层**：第一次成功进入后，预热这台酒馆实际加载过的核心文件和内置扩展资源。下次从本地返回；个人单账号酒馆可额外开启第三方扩展缓存。1Panel 反代配置还可改善首次访问。

聊天、角色卡、背景、用户头像、设置、CSRF 和所有生成 API 响应都不会进入 Cache Storage。

## 安装

它同时包含 SillyTavern UI 扩展和可选服务端插件。你可以根据自己的权限选择下面任一模式。

- **只装 UI（最简单）**：在酒馆里粘贴 Git 地址安装。长聊天优化、聊天截断、正则刷新和性能指标立即可用；面板显示“仅 UI 模式”是正常状态。
- **完整增强**：同时安装 UI 与服务端部分，并使用 HTTPS/localhost。除上述功能外，再启用跨页面静态资源缓存。

只有选择完整增强时，才需要在**运行 SillyTavern 服务器的环境**执行一次命令：安卓是 Termux，Windows 用 PowerShell，Mac 用终端，1Panel 用 Xterminal。SillyTavern 页面内的“安装扩展”只能安装 UI 部分，不能越权写入服务器 `plugins/` 目录或开启 `enableServerPlugins`。

本项目的唯一安装地址是：

```text
https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator
```

### 方式 A：只安装 UI 扩展

1. 进入 SillyTavern 的“扩展”。
2. 选择“安装扩展”。
3. 粘贴下面的地址并确认：

```text
https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator
```

不需要重启服务器。打开“扩展设置 → 云酒馆加速器”，看到“仅 UI 模式 · 前端优化可用”即安装成功。纯 UI 模式不会反复弹错，也不会尝试绕过管理员权限安装服务端代码。

### 方式 B：一键安装完整增强

一键安装器会自动完成“服务端插件 + 全局 UI 扩展 + `enableServerPlugins: true` + 配置备份”。**使用一键安装后，不需要再去酒馆里粘贴 Git 地址安装 UI。**

1Panel Xterminal、Linux 或 macOS：先 `cd` 进入 SillyTavern 根目录，然后执行：

```bash
curl -fsSL https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.sh | bash
```

如果当前不在 SillyTavern 根目录，可直接传入路径：

```bash
curl -fsSL https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.sh | bash -s -- /path/to/SillyTavern
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.ps1'))) -SillyTavernRoot 'C:\SillyTavern'
```

安装完成后仍需要手动重启 SillyTavern；安装器不会猜测并操作你的 1Panel 容器名称。完整的路径判断、Windows 命令、更新、卸载和排错请看：[完整使用教程](docs/完整使用教程.md)。

### 手动安装完整增强（不使用脚本时）

#### 1. 安装服务端部分

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

手动安装时，在 SillyTavern 根目录的 `config.yaml` 中，**唯一必须手动确认的配置**是：

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

#### 2. 安装 UI 扩展

如果第 1 步是手动安装服务端部分，再通过 SillyTavern 安装 UI：

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

#### 3. 确认 HTTPS（仅静态缓存需要）

Service Worker 只能在 HTTPS 或 localhost 上工作。云酒馆必须用正常域名证书访问，不要用裸 `http://IP:端口`。

**没有购买域名也可以使用 HTTPS。** 例如服务器 IP 是 `23.94.194.240`，[sslip.io](https://sslip.io/) 会把下面的免费主机名自动解析到该 IP：

```text
23-94-194-240.sslip.io
```

在 1Panel 创建反向代理网站，主域名填这个免费主机名，代理地址填 `http://127.0.0.1:8000`（端口按实际修改），再用 HTTP 验证申请 Let's Encrypt 证书。最后从 `https://23-94-194-240.sslip.io` 进入，不再带 `:8000`。详细步骤见[完整使用教程](docs/完整使用教程.md#没有自有域名时的-https-方法)。

完成后，在 1Panel 重启 SillyTavern 容器/进程，然后刷新酒馆页面。打开“扩展设置 → 云酒馆加速器”，状态显示“完整模式”即表示两个部分都已正常连接。

## 1Panel 首访优化（可选，推荐）

[`1panel/nginx-static.conf.example`](1panel/nginx-static.conf.example) 是一份只命中程序静态目录的 Nginx 片段。

1. 先在 1Panel 备份当前网站配置。
2. 打开“网站 → 配置 → 配置文件”。
3. 把片段放入已有的 `server { ... }` 内。
4. 把片段中的 `proxy_pass http://127.0.0.1:8000;` 改成你现有 SillyTavern 反代使用的上游。
5. 用 1Panel 的配置检查通过后再重载 OpenResty/Nginx。

如已经存在同样的正则 `location`，不要直接叠加；把 `gzip`、`proxy_hide_header`、`expires` 和 `add_header` 合并进原规则。

## 使用

安装后打开“扩展设置 → 云酒馆加速器”。全局前端接管默认开启，所有页面内复用数据都会在刷新网页后消失，不会写入 Service Worker：

- **强力前端接管（仅 UI）**：总开关；统一管理下面所有前端代理，关闭或熔断后立即恢复酒馆原生流程。
- **接管强度**：平衡、强力、极致分别使用约 8、10、12 ms 的单帧预算。
- **提前显示主界面**：官方设置加载完成后释放启动遮罩，同时显示后台初始化提示，`APP_READY` 后撤下。
- **初始化请求预取与去重**：短期复用完全相同的角色、头像、背景、扩展发现与静态模板请求；不复用生成、聊天保存、设置保存、上传、登录和 CSRF 请求。
- **正则编辑器统一刷新**：检测实际保存后的正则状态变化，连续操作合并成一次视口优先分帧刷新。
- **自适应首屏消息数**：结合聊天文本、富组件标记、设备核心数和内存提示自动选择 8～30 条。
- **自动加载旧消息**：接近顶部或点击官方“显示更多”时小批补载，并保持当前可见消息位置。
- **聊天代码延迟高亮**：最近 3 条优先，屏幕外旧代码进入视口后再高亮；可选完全跳过或折叠旧代码。
- **移动端滑动保护**：明确区分纵向滚动与横向 Swipe，减少误切消息。
- **重美化聊天模式（仅 UI）**：适合消息不多、但每条都被正则变成人物卡、仪表盘或复杂折叠块的聊天；一键联动官方聊天截断和屏幕外渲染减负，关闭后恢复之前的设置。
- **长聊天渲染减负（仅 UI）**：普通模式下消息达到 20 条后启用；重美化模式下直接启用，并始终保护最近 5 条消息。
- **长聊天流畅模式（仅 UI）**：兼容手动模式，可选每批显示 8、10、15、20、30 或 50 条；启用自适应首屏时由接管器自动管理。
- **重新应用正则（仅 UI）**：保留当前聊天页面，优先刷新视口内和最近 5 条消息，再分帧更新其余已显示消息；默认不清缓存、不重新请求聊天，再次点击会取消旧刷新。
- **平滑加载更早 10 条（仅 UI）**：通过 SillyTavern 官方接口小批量补入旧消息，并锚定当前可见消息避免滚动跳动。
- **完整重载（高级，仅 UI）**：清空正则编译缓存并重新请求、渲染当前聊天，只在局部刷新无效或正则状态异常时使用，执行前会二次确认。
- **聊天加载诊断（仅 UI）**：显示聊天请求耗时与传输量、本次显示/总消息数、DOM 节点、美化复杂度、首批内容出现、前端处理估算、完整加载和最长主线程阻塞。
- **启用静态资源缓存（服务端增强）**：注册/卸载本项目的 Service Worker。
- **自动预热当前版本一次（服务端增强）**：默认关闭；仅在 `APP_READY` 后、页面可见、非省流/低速网络和浏览器空闲时运行，同一版本不重复自动预热。
- **缓存第三方扩展**：默认关闭。如这是你一个人使用的单账号云酒馆，可开启来减少扩展文件往返；多账号共用同一域名时保持关闭，避免账号间复用同路径文件。
- **立即预热**：新安装一批扩展后可手动执行。
- **清空并重建**：遇到样式/扩展文件不同步时使用。
- **刷新缓存状态**：仅在展开面板或手动点击时枚举缓存，避免启动阶段反复统计。
- **删除本机缓存**：只注销当前浏览器/设备上的 Service Worker 并清理本插件缓存，不影响前端优化，也不删除聊天、角色卡、设置或服务器文件。

面板会显示 TTFB、DOM 可交互时间、首页传输量、HTTP 协议和当前 Worker 生命周期的本地命中数。

聊天诊断仍是旁路测量。“前端处理估算”包含 JSON 解析、正则、Markdown、HTML 清洗、DOM 创建及其他扩展处理，不能精确拆成单独的正则毫秒数。“美化复杂度”是 DOM、HTML 体积和富组件数量的综合参考值。1.5.0 的 `fetch` 与 `hljs` 代理均有严格作用域：请求层只处理白名单且只在内存短期复用，高亮层只延迟 `#chat` 内旧代码块。

### 逃生与自动恢复

- 地址后加 `?cla-safe=1`：本次打开跳过全部前端接管，服务端静态缓存仍可使用。
- 连续 3 次接管异常：自动熔断并关闭总开关，恢复酒馆原生流程。
- 聊天切换后持续空白 8 秒：自动调用官方完整聊天读取作为回退。
- 面板“暂停当前前端任务”：取消统一队列和当前分帧任务。
- 面板“恢复酒馆原生流程”：还原 `fetch`、高亮、滚动、触摸、Observer 和计时器。

## 更新安全

- 根页面每次都走网络，不离线缓存 HTML，因此登录跳转不会被古老页面拦住。
- 根页面的 `ETag` 或 `Last-Modified` 变化时，会在任何 JS/CSS 执行前废弃旧资源缓存。
- SillyTavern 扩展安装、更新、删除、移动或切分支成功后，会自动失效程序资源缓存。API 响应本身不被缓存。
- 如站点根路径已存在其他 Service Worker，本项目会拒绝覆盖并在面板报错。

## 效果边界

能明显改善的是第二次及以后访问中，核心脚本、样式、字体、语言包和扩展文件带来的多次跨网往返。

完整增强模式可在 SillyTavern 发出 `APP_READY` 后、页面可见且浏览器空闲时，提前预热正则编辑器、调试器和主题对话框的静态模板。预热并发数限制为 3，避免与首页字体、美化和聊天渲染抢网络。纯 UI 模式不会执行预热。

它不会缩短：

- AI 接口的生成时间。
- 第一次访问时的完整网络下载（需依靠 1Panel/CDN 层改善）。
- 当前屏幕内一个超大正则 HTML 块首次展开时的全部 DOM 计算；“长聊天渲染减负”主要减少其他屏幕外消息的干扰。
- `/api/settings/get`、`/api/characters/all` 等动态初始化的服务器处理时间；其中角色库已通过官方 `performance.lazyLoadCharacters` 设置针对。
- 浏览器主动清除站点数据、无痕窗口或 iOS 因存储压力回收缓存后的重新预热。

## 排查

**面板显示“仅 UI 模式”**

- 如果你只想使用前端优化，这是正常状态，无需处理。
- 如果你想启用静态缓存，再确认项目位于 `plugins/cloud-lounge-accelerator/`、`enableServerPlugins: true`，并重启 SillyTavern。
- 服务端安装失败时查看容器日志中的 `Plugin loading failed` / `Failed to load plugin`。

**面板显示“需要 HTTPS”**

- 从 `https://你的域名` 进入，确认证书无错误。
- 确认 1Panel 反代传递 `X-Forwarded-Proto $scheme`。

**第二次还是慢**

1. 展开面板或点“刷新缓存状态”，查看“完整模式 · 已缓存 N 个程序资源”；`N = 0` 时点“立即预热”。
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
