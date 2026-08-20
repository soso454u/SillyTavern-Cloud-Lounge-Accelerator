# 云酒馆加速器 2.1.14

让云端 SillyTavern 打开更快、长聊天更流畅，同时避免重复接管预设、正则和世界书的原生交互。安装后大部分功能都会自动工作，不需要手动调整复杂参数。

### 只安装 UI 扩展

进入 SillyTavern 的“扩展 → 安装扩展”，粘贴：

```text
https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator
```

安装后即可使用启动、聊天、正则与界面操作优化。

## 一键安装完整版本

一键安装会同时安装界面扩展和服务端加速。安装完成后，请手动重启 SillyTavern。

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

普通安装不会改动 SillyTavern 的性能开关。需要在安装时直接开启时，可单独使用 `--keep-alive`、`--lazy-characters`，或用 `--fast-start` 同时开启两项：

```bash
curl -fsSL https://raw.githubusercontent.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator/main/scripts/install.sh | bash -s -- --fast-start
```

Keep-Alive 在部分网络环境可能引发 `ECONNRESET` 或连接中断；角色卡懒加载可能不兼容旧扩展，并会让高级模糊搜索只按角色名搜索。两项都要重启 SillyTavern 才生效。

## 主要功能

### 页面加载加速

- 只缓存 SillyTavern 的脚本、样式、字体、语言包、图片和声音等程序资源。
- 完成登录后才检查版本并启动页面缓存，不会干扰登录过程。
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

启动性能优化
HTTP Keep-Alive                 [关]
角色卡懒加载                    [关]

[重新渲染当前聊天]

遇到显示异常？
[修复插件]

高级信息 ▸
```

展开“高级信息”可以查看插件版本、页面缓存、服务端插件、缓存资源数和各项优化的运行状态。

“启动性能优化”直接读取并修改 SillyTavern 根目录的 `config.yaml`。两项互不绑定，开启前会显示副作用确认；只有内容实际变化时才写入，失败会自动回滚。备份统一放在 `.cloud-lounge-accelerator/backups/`：永久保留 1 份插件修改前基线，滚动保留最近 3 份不同内容的快照。仅安装 UI 扩展时，这两个开关会保持不可用。

## 支持模式

| 安装方式 | 页面静态缓存 | 启动/聊天/正则/交互优化 |
| --- | --- | --- |
| 仅安装 UI 扩展 | 否 | 是 |
| UI 扩展 + 服务端插件 + HTTPS | 是 | 是 |
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

升级 2.1.14 后，键盘弹出仍只在输入区被实际遮挡时局部移动 `#form_sheld`。收回阶段不再等待 WebKit 最后一条 `visualViewport` 回调：失焦后先跟随正常视口变化，若短暂窗口内仍未回落，则以 80ms 局部动画主动归零并清理。因此不会再出现键盘已消失、输入区仍悬着、底下留出大块空白后突然贴底的情况。变量和 class 都只写在输入区本身，不影响长聊天 DOM 的样式计算；不改 `#sheld`、聊天高度或滚动位置。请同步更新 UI 与服务端目录并重启 SillyTavern。

遇到样式、Worker 或资源不同步时，打开面板点击“修复插件”。它会：

1. 停止本插件的前端优化模块。
2. 注销本插件的 Worker 并只清理本插件缓存。
3. 重新注册 Worker、读取登录后的版本签名并预热当前资源。
4. 重新启动已开启的三个功能区。

它不会删除聊天、角色卡、世界书、预设或服务器配置。

## 安全与边界

- 服务端插件只提供健康检查、Service Worker 脚本和两项明确授权的性能配置接口；配置写入只处理安装器控制项、`enableKeepAlive` 或 `performance.lazyLoadCharacters`，不读写聊天、角色卡或密钥。
- 页面缓存只改善第二次及以后访问的静态资源往返，不会缩短 AI 生成时间。
- 第一次访问速度主要依赖服务器、线路、TLS、反向代理和 SillyTavern 本身。
- 如果根作用域已有其他 Service Worker，本插件拒绝覆盖。
- SillyTavern 不应在没有账号、访问控制或可信网络边界时直接暴露到公网。

## 许可证

AGPL-3.0-only。
