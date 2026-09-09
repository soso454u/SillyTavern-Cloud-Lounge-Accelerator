# 云酒馆加速器 2.1.21

让云端 SillyTavern 打开更快、长聊天更流畅，同时避免重复接管预设、正则和世界书的原生交互。安装后大部分功能都会自动工作，不需要手动调整复杂参数。

### 只安装 UI 扩展

进入 SillyTavern 的“扩展 → 安装扩展”，粘贴：

```text
https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator
```

安装后即可使用启动、聊天、正则与界面操作优化。

## 一键安装完整版本

一键安装会同时安装界面扩展和服务端加速。安装完成后，请手动重启 SillyTavern。

一键安装的界面扩展属于**全局扩展**，供所有酒馆账号使用。启用多用户后，只有酒馆管理员账号能在扩展管理器里更新它；普通账号仍可更新自己安装的个人扩展。因此“其他插件能更新，加速器提示没有更新全局扩展的权限”通常是安装范围不同。保持多用户开启，切换到管理员账号更新即可；需要同时更新服务端时，重新运行下面的安装命令。

### VPS / 1Panel XTerminal

```bash
cd /root/SillyTavern
curl -fsSL https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.sh | bash
```

### Android / Termux

```bash
pkg install curl -y
cd ~/SillyTavern
curl -fsSL https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.sh | bash
```

### Mac / 终端

```bash
cd ~/SillyTavern
curl -fsSL https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.sh | bash
```

### Windows PowerShell

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.ps1'))) -SillyTavernRoot 'D:\SillyTavern\SillyTavern'
```

这些命令同时适用于首次安装和以后更新。路径与教程不同时，只修改 `cd` 后的路径或 Windows 的 `-SillyTavernRoot`；安装完成后重启 SillyTavern。

更多安装、更新、卸载、1Panel 和 HTTPS 步骤见 [完整使用教程](docs/完整使用教程.md)。

普通安装/更新现在会开启聊天保存上传压缩；Keep-Alive 和角色卡懒加载仍保持原值。需要在安装时直接开启后两项时，可单独使用 `--keep-alive`、`--lazy-characters`，或用 `--fast-start` 同时开启：

```bash
curl -fsSL https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.sh | bash -s -- --fast-start
```

Keep-Alive 在部分网络环境可能引发 `ECONNRESET` 或连接中断；角色卡懒加载可能不兼容旧扩展，并会让高级模糊搜索只按角色名搜索。两项都要重启 SillyTavern 才生效。

## 主要功能

### 页面加载加速

- 只缓存 SillyTavern 的脚本、样式、字体、语言包、图片和声音等程序资源。
- 完成登录后才检查版本并启动页面缓存，不会干扰登录过程。
- 反向代理已提供至少 5 分钟的有效浏览器缓存时，自动注销 Worker 并直通原生 HTTP/disk cache，避免静态资源额外等待 Worker 冷启动；没有可靠缓存头时继续使用 Worker。
- UI 与服务端插件版本不一致时会自动注销旧 Worker 并停止页面缓存，防止服务端旧代码被反复装回。
- 检测到 iOS 主屏幕独立 Web App 与 HTTP Basic Auth 同时使用时，会自动注销并停用根作用域 Worker，保留启动、聊天、正则和交互优化。
- 当前版本在浏览器空闲、页面可见且网络允许时只自动预热一次。
- 扩展安装、更新或删除后，自动清理旧的程序缓存。
- 启动阶段短时间合并完全相同的角色、头像、背景、扩展发现和模板请求。

登录兼容：

- 不接管页面跳转，兼容 Basic Auth、登录页和反向代理认证。
- 登录失败、无权访问、认证提示和跳转响应不会被缓存。
- API、聊天、角色卡、背景、缩略图、用户文件和第三方扩展资源不会被缓存。

### 聊天与重美化优化

- 一键安装/更新会开启 SillyTavern 官方请求 gzip：超过 256KB 的聊天保存先在浏览器压缩再上传，并取消官方默认 8MB 压缩上限，15MB 等大聊天也会生效；压缩超时会回退原始保存。
- 保存语义仍是官方的完整聊天覆盖，服务端完整性检查和聊天备份保持不变。插件不使用自定义增量协议，避免编辑旧楼、删除消息、切换 Swipe、元数据变化或多端并发时损坏 JSONL。
- 打开任何角色聊天时都只先显示最后 5 条，直接进入最近的聊天内容。
- 切换聊天后的首秒布局变化会通过 SillyTavern 官方滚动接口继续贴住最后一条；一旦用户触碰或加载历史消息便立即停止校准。
- 点击“显示更多”时由 SillyTavern 原生流程每页补载 5 条旧消息并保持阅读位置；插件会先登记当前会话，不会把这次补载误判成首次进入而跳到底部。
- 最近代码优先高亮；旧代码进入视口后再处理，并默认以可点击预览形式折叠。
- 完整 HTML 源码即使没有 `language-html` 类名也会跳过语法高亮，避免在最终美化出现前重复处理大量节点。
- 流式生成和停止清理期间暂停代码块扫描，等 SillyTavern 真正解锁后只合并执行一次。
- 移动端区分横向 Swipe 与纵向滚动，减少误切消息。
- 编辑已有正则或切换开关时，只刷新原始消息中可能受该条正则影响的内容；无关的剧情选项、状态栏和人物面板保持原样。
- 只修改正则名称或只影响提示词时不刷新聊天；调整顺序、作用范围或使用过于宽泛的查找式时才安全刷新全部已显示消息。
- 单条局部刷新失败不会拆掉整段聊天；只有 SillyTavern 局部刷新接口整体不可用时才回退完整重载。

### 界面操作优化

- 预设、正则和世界书的拖拽、手机手柄和顺序保存完全使用 SillyTavern 原生实现。
- 插件不禁用官方 sortable、不捕获 `pointerdown`，也不在拖动期间二次渲染预设列表。
- 生成期间可以连续切换预设条目，图标和当前行会立即变化并保存；生成解锁后才合并执行一次 Token 重算。
- 手机在生成期间会于手指抬起时处理预设开关，并过滤 Safari 随后的重复点击；非生成状态和鼠标点击仍走官方原生流程。
- 全平台看护 SillyTavern 原生 modal 关闭流程：只有已经失效的透明关闭/加载遮罩才会被自动解除，真正活动的弹窗和加载任务保持阻塞。
- 用户明确点按聊天输入框却没有获得焦点时，插件才会核对 `disabled`、`readonly`、`inert`、可见性与命中元素；确认可输入后恢复焦点，不定时抢焦点，也不影响其他编辑框。
- 残留层挡住普通按钮时只解除已经确认失效的 blocker，不替用户重放点击；高级信息和控制台会记录恢复原因、阻塞元素、次数与浏览器环境。
- 快捷回复执行窗处于透明最小化状态时，点到背景会将控制窗展开，但不会擅自终止正在执行的脚本。
- 桌面顶栏抽屉保持 160/130ms 的官方高度展开；1000px 以下粗指针设备的普通顶栏抽屉改为一次完成高度布局，只做 `transform + opacity` 合成动画，普通触屏为 90/70ms，iPhone/iPad 为 80/60ms。
- 手机普通顶栏抽屉打开期间持续关闭实时毛玻璃，避免动画结束重新创建 blur 图层；左右大抽屉、桌面布局与系统“减少动态效果”保持官方行为。
- Popup 直接跟随 SillyTavern 官方 `[opening]` / `[closing]` 生命周期采用同档时长，关闭阶段立即停止重复交互，动画结束由官方流程清理。
- 拖动预设、世界书或正则时，只对包含官方 sortable helper 的当前面板临时移除模糊、阴影和过渡；排序、落点与保存仍全部交给 SillyTavern。
- 弹窗自愈不再监听整个页面的所有 `class` 变化；全局只筛选弹窗结构变化，具体状态只监听具体弹窗，并把同一帧的检查合并一次。
- 生成期间切换不会改变已经发送给模型的当前请求，从下一次生成、继续或重新生成开始生效。

## 设置面板

打开“扩展设置 → 云酒馆加速器”后会看到：

```text
云酒馆加速器

● 运行正常

页面加载加速                    [开]
聊天与重美化优化                [开]
界面操作优化                    [开]

云端性能优化
聊天保存上传压缩              [开]
HTTP Keep-Alive                 [关]
角色卡懒加载                    [关]

[重新渲染当前聊天]

遇到显示异常？
[修复插件]

高级信息 ▸
```

展开“高级信息”可以查看插件版本、页面缓存、服务端插件、缓存资源数和各项优化的运行状态。

“云端性能优化”直接读取并修改 SillyTavern 根目录的 `config.yaml`。三个选项互不绑定，开启前会显示影响确认；只有内容实际变化时才写入，失败会自动回滚。备份统一放在 `.cloud-lounge-accelerator/backups/`：永久保留 1 份插件修改前基线，滚动保留最近 3 份不同内容的快照。仅安装 UI 扩展时，这些开关会保持不可用。

## 支持模式

| 安装方式 | 页面静态缓存 | 启动/聊天/正则/交互优化 |
| --- | --- | --- |
| 仅安装 UI 扩展 | 否 | 是 |
| UI 扩展 + 服务端插件 + HTTPS | 是；自动选择原生 HTTP 缓存或 Worker | 是 |
| iOS 主屏幕 Web App + Basic Auth | 自动停用以兼容认证 | 是 |

静态缓存必须使用 HTTPS 或 localhost。纯 UI 模式不要求服务器权限，也不会因服务端插件缺失而报错。

## 手动安装

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

2.1.21 修复反向代理已有强缓存时 Service Worker 反而为静态资源增加约百毫秒等待的问题：插件会检查 `/style.css` 与 `/script.js` 的实际响应缓存头，两者剩余新鲜期都至少 5 分钟时自动注销 Worker，让浏览器直接使用原生 HTTP/disk cache；否则保留 Worker 作为普通 VPS 的静态缓存。Worker 模式同时复用 CacheStorage 句柄并降低预热并发。切换到原生缓存后，高级信息会显示“原生缓存”；已有页面在下次重新加载后完全脱离旧 Worker 控制。

2.1.20 新增“聊天保存上传压缩”：一键安装/更新默认安全写入 `performance.requestCompression`，256KB 以上请求使用官方 gzip、取消 8MB 上限并把压缩超时放宽到 15 秒；设置面板可独立开关。保存仍走原生完整覆盖、完整性检查和备份，不改写聊天数据。另明确说明：本插件的 5 条限制只影响 DOM 显示；聊天补全预设若关闭或缺少 `chatHistory` marker，SillyTavern 会跳过过往消息注入。

2.1.19 整理内部代码结构：设备与触控环境统一由一个工具模块识别，入口运行模块集中管理，三个设置开关各自维护启停流程；同时移除界面动画中已经停用的帧句柄代码。此版本不改变功能和设置，保留 2.1.18 的 iOS 输入框即时显现修复。

2.1.18 修复 iOS Safari 点按聊天输入框后键盘已出现、输入区却要等输入第一个字才显现的问题。插件只在 iPhone/iPad 的聊天输入框仍保持焦点时，跟随 `visualViewport` 变化并用浏览器原生 `scrollIntoView()` 让它进入可见区域；不恢复旧版的输入区平移，不修改聊天高度、聊天滚动、文字或光标。键盘收回后仍由 SillyTavern 原生布局自然归位。

2.1.17 修复开启“界面操作优化”后，从角色详情跳转关联世界书，点击世界书内容却关闭面板的问题。插件不再改写酒馆原生的抽屉层级规则，手机端世界书也能正确显示在角色详情上方。升级后请重新加载页面，让旧版写入 CSSOM 的规则恢复。

2.1.16 恢复 SillyTavern 原生输入布局：移除单独上抬输入区的键盘补偿和主动归零动画，聊天区与输入区重新保持同一 flex 布局关系。原生键盘出现时的视口移动仍由浏览器与酒馆版本决定；此版本不额外修改聊天高度、滚动或输入选区。弹窗自愈优先完成酒馆自己的关闭流程，并保留正在执行的快捷回复、活动加载任务与编辑框焦点。请同步更新 UI 与服务端目录、重启 SillyTavern，并重新加载 Safari 页面以卸载旧版监听器。

2.1.15 的预设正则总开关与扩展面板折叠修复一并保留。

遇到样式、Worker 或资源不同步时，打开面板点击“修复插件”。它会：

1. 停止本插件的前端优化模块。
2. 注销本插件的 Worker 并只清理本插件缓存。
3. 检查原生 HTTP 缓存；仅在缓存策略不足时重新注册 Worker、读取登录后的版本签名并预热当前资源。
4. 重新启动已开启的三个功能区。

它不会删除聊天、角色卡、世界书、预设或服务器配置。

## 安全与边界

- 服务端插件只提供健康检查、Service Worker 脚本和明确授权的性能配置接口；配置写入只处理安装器控制项、`enableKeepAlive`、`performance.lazyLoadCharacters` 或 `performance.requestCompression`，不读写聊天、角色卡或密钥。
- 页面缓存只改善第二次及以后访问的静态资源往返，不会缩短 AI 生成时间。
- 第一次访问速度主要依赖服务器、线路、TLS、反向代理和 SillyTavern 本身。
- 如果根作用域已有其他 Service Worker，本插件拒绝覆盖。
- SillyTavern 不应在没有账号、访问控制或可信网络边界时直接暴露到公网。

## 许可证

AGPL-3.0-only。
