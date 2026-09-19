# SW Cache — 开发文档

> 面向开发者。面向最终用户的安装/使用说明见 [README.md](./README.md)。

## 1. 项目定位

SW Cache 是 SillyTavern（酒馆）的**前端静态资源缓存加速方案**，由一个**注册扩展** + 一个**Service Worker** 组成。目标是解决手机等设备二次访问酒馆时「全量冷加载约 10MB 资源、耗时几分钟」的问题。

核心思路：酒馆前端是源码直出（`script.js` + 约 90 个 ES Module），默认无任何 Service Worker 缓存。本项目在 `public/` 根目录放置一个 Service Worker，把白名单内的静态资源缓存到浏览器本地，二次访问直接命中本地缓存。

## 2. 架构总览

```
┌────────────────────────────────────────────────────────────┐
│                        浏览器（手机/桌面）                     │
│                                                            │
│  ┌─────────────────────┐        ┌──────────────────────┐   │
│  │  注册扩展 index.js    │        │  Service Worker      │   │
│  │  · 检测根文件存在      │  注册   │  service-worker.js   │   │
│  │  · 注册/注销 SW       │ ─────▶ │  · 预缓存核心资源      │   │
│  │  · 注入设置面板        │        │  · 拦截静态资源请求     │   │
│  │  · 清空缓存           │ ◀───── │  · SWR 策略          │   │
│  └─────────────────────┘  postMsg └──────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                        ▲
                        │ fetch 拦截
                        ▼
              ┌─────────────────────┐
              │  SillyTavern 服务端   │
              │  public/ 静态目录     │
              └─────────────────────┘
```

## 3. 文件职责

| 文件 | 位置 | 职责 |
|------|------|------|
| `manifest.json` | 仓库根目录 | 扩展清单，`js` 字段指向 `index.js`，供 GitHub 链接安装 |
| `index.js` | 仓库根目录 | 扩展逻辑：检测根文件 → 注册/注销 SW → 注入设置面板 |
| `service-worker.js` | 仓库根目录 | 核心缓存逻辑，需用户复制到酒馆 `public/` 根目录 |
| `README.md` | 仓库根目录 | 面向用户的安装/使用说明 |

> **关键点**：`manifest.json` 与 `index.js` 必须放在**仓库根目录**，否则酒馆通过 Git 链接安装时无法识别扩展入口。

## 4. 两个组件的职责边界

### 4.1 注册扩展（index.js）

- **不承载缓存逻辑**，只做「注册器」+「控制面板」。
- 职责：
  1. 检测 `public/` 根目录是否存在 `service-worker.js`（`HEAD` 请求）。
  2. 存在 → 调用 `navigator.serviceWorker.register('/service-worker.js')` 注册。
  3. 不存在 → 弹出提示，优雅降级（不影响酒馆功能）。
  4. 在扩展设置页面注入可展开面板，提供状态查看 + 手动注册/注销/清空缓存。

### 4.2 Service Worker（service-worker.js）

- 承载全部缓存逻辑。
- 因浏览器规范限制，SW 的作用域由文件路径决定，**必须放在 `public/` 根目录**才能作用域为 `/`，进而缓存 `/script.js`、`/css/` 等根级资源。这是无法通过第三方扩展目录绕过的硬性约束。

## 5. 扩展加载机制（SillyTavern 内部）

扩展的激活流程（由酒馆 `scripts/extensions.js` 驱动）：

1. 酒馆扫描 `public/scripts/extensions/third-party/<name>/` 目录，读取 `manifest.json`。
2. 检查扩展是否在 `extension_settings.disabledExtensions` 列表中；不在则默认启用。
3. 通过 `addExtensionScript()` 动态创建 `<script type="module" src="/scripts/extensions/<name>/<manifest.js>">` 标签，**异步加载**扩展 JS。
4. 扩展 JS 是 IIFE，加载即执行 `init()`。

**对开发者的启示**：
- 扩展 JS 是**异步加载**的，加载时机晚于首屏 DOM，因此面板注入需要处理时序。
- 扩展未被显式禁用即会加载；排查「面板不显示」时，先确认 JS 是否真正加载（看网络请求/控制台），再查 DOM 注入。

## 6. 设置面板注入机制

### 6.1 目标容器

面板挂载到 `#extensions_settings` 或 `#extensions_settings2`（酒馆 index.html 中预定义的扩展设置容器）。

### 6.2 面板结构

采用酒馆的 `inline-drawer` 抽屉样式：

```text
<div class="inline-drawer" id="sw-cache-panel">
  <div class="inline-drawer-toggle inline-drawer-header">  ← 标题条（可点击展开）
  <div class="inline-drawer-content">                       ← 抽屉内容
    <div style="padding; display:flex; flex-direction:column; gap">  ← 内层 wrapper
```

> **重要坑位**：不能在 `.inline-drawer-content` 上直接写 `display: flex`。
> 酒馆 `script.js` 的全局事件委托会用 jQuery `slideToggle` 强制设置该元素的
> `display: block/none` 来展开/收起，直接写 `flex` 会被覆盖导致布局错乱。
> 因此 flex 布局必须放在**内层 wrapper** 上。

### 6.3 挂载时序（健壮性设计）

面板挂载采用多层兜底，确保容器出现时总能挂上：

1. **DOMContentLoaded / 立即执行**：`document.readyState` 判断后调用 `ensurePanelWithRetry()`。
2. **定时重试**：`ensurePanelWithRetry()` 内 20 次 × 300ms 轮询，等待容器出现。
3. **酒馆事件**：监听 `APP_READY` 与 `SETTINGS_LOADED` 事件，容器延迟挂载时再触发。
4. **MutationObserver 兜底**：观察 `document.body` 的 `childList/subtree` 变化，面板缺失时用 `requestAnimationFrame` 节流后自动补挂载。

第 4 点是关键——酒馆扩展设置 DOM 可能被动态重建/移除，仅靠定时器和事件不足以覆盖所有场景，MutationObserver 保证「容器一出现/面板一消失」就能自动恢复。

### 6.4 幂等性

- `globalThis.__swCachePanelLoaded` 标志防止重复初始化监听器。
- `ensurePanel()` 检查 `#sw-cache-panel` 是否已存在，避免重复 append。

## 7. Service Worker 缓存策略

### 7.1 缓存命名

```js
const STATIC_CACHE = 'st-static';   // 单一持久缓存桶
```

采用单一持久桶，升级不再清空整桶。旧版（`st-static-v*`）历史桶在 `activate` 阶段自动清理迁移。

### 7.2 三种请求处理

| 请求类型 | 策略 | 实现函数 |
|---------|------|---------|
| 导航请求（`request.mode === 'navigate'`） | network-first | `networkFirst()` |
| 静态资源（白名单命中） | stale-while-revalidate | `staleWhileRevalidate()` |
| 其余（POST/PUT、跨域、API、用户数据、第三方扩展） | 不拦截，直连网络 | — |

### 7.3 静态资源白名单（安全核心）

采用「白名单」而非「排除 API 后全缓存」，确保缓存中绝不夹带隐私数据：

```js
STATIC_PATH_PREFIXES = ['/css/', '/img/', '/lib/', '/locales/', '/webfonts/', '/sounds/'];
SCRIPTS_PREFIX       = '/scripts/';
SCRIPTS_EXCLUDE      = '/scripts/extensions/third-party/';  // 用户安装的第三方扩展，动态路由，必须排除
STATIC_ROOT_FILES    = ['/script.js', '/lib.js', '/style.css', '/favicon.ico', '/manifest.json', '/robots.txt'];
```

**必须排除的路径**（一旦缓存会泄漏隐私或显示旧数据）：
- `/api/*`：聊天记录、用户信息等动态/认证数据
- `/backgrounds`、`/characters`、`/assets`、`/user/*`：用户目录
- `/scripts/extensions/third-party/*`：用户安装的第三方扩展

### 7.4 拦截前置条件（fetch 事件）

```js
if (request.method !== 'GET') return;              // 只处理 GET
if (url.origin !== self.location.origin) return;   // 只处理同源
```

POST/PUT、跨域、WebSocket 等一律放行，确保不干扰酒馆正常功能。

### 7.5 生命周期

- **install**：打开 `STATIC_CACHE`，读取预缓存清单（优先 `/precache-manifest.json`，缺失退回内置 `PRECACHE_URLS`），`Promise.allSettled` 预缓存（个别 404 不阻断），并 `skipWaiting()` 立即接管。
- **activate**：删除所有非当前桶的缓存（含旧版 `st-static-v*` 历史桶），执行一次 LRU 淘汰，并 `clients.claim()` 让新 SW 立即控制页面。
- **message**：响应页面发来的 `clear-cache`（清空并回复）、`skip-waiting`（强制接管）、`get-stats`（返回统计）、`set-cache-limit`（设置容量上限）。

### 7.6 更新机制（文件级，非整桶）

静态资源更新时（内容变化、URL 不变），SWR 后台会用新内容覆盖旧条目，**无需修改版本号、无需清空整桶**。超出容量上限时按「最久未访问优先」淘汰单个条目。

### 7.7 缓存容量上限与 LRU

- 默认上限 `DEFAULT_CACHE_LIMIT` = 50MB，页面可通过 `set-cache-limit` 消息调整（`localStorage` 持久化）。
- `enforceCacheLimit()` 遍历条目按大小与访问时间排序，最久未访问的优先淘汰，直到总大小低于上限。
- 缓存写入每累计 `LRU_THROTTLE` 次触发一次后台 LRU（节流，不阻塞返回）。

## 8. 页面与 SW 的通信

扩展通过 `postMessage` + `MessageChannel` 与 SW 通信（带 3 秒超时兜底）：

1. 扩展通过 `getActiveWorker()` 获取激活的 worker。
2. 创建 `MessageChannel`，用 `port1` 监听回复，超时自动 `resolve(undefined)`。
3. `worker.postMessage(message, [channel.port2])`。
4. SW 通过 `event.ports[0].postMessage(reply)` 回复（而非 `event.source`）。

支持的消息：`clear-cache` / `skip-waiting` / `get-stats` / `set-cache-limit`。

### 8.1 预缓存清单（可选增强）

- 若构建期生成了 `/precache-manifest.json`（含 `script.js` 全部静态 import 依赖），SW 在 install 阶段优先使用，冷启动更彻底。
- **该文件是可选增强**：缺失时 SW 自动退回内置最小清单（约 10 个入口文件），功能完全正常，不影响通用性。
- 生成脚本见 `generate-preload.mjs`：从 `script.js` / `lib.js` 递归解析静态 import 依赖 + 整目录静态资源，输出到 `public/precache-manifest.json`。

## 9. 关键设计决策与权衡

| 决策 | 理由 |
|------|------|
| SW 放 `public/` 根目录 | 浏览器规范：SW 作用域 = 文件所在目录，放根目录才能作用域 `/` |
| 白名单而非黑名单 | 安全优先，宁少勿漏，杜绝隐私数据被缓存 |
| 排除第三方扩展目录 | 第三方扩展是动态路由（`?ver=` 参数 + 用户数据），缓存会导致旧版本/串号 |
| `Promise.allSettled` 预缓存 | 个别文件 404 不阻断 SW 安装，提升健壮性 |
| SWR 策略（静态资源） | 二次访问秒开，同时后台静默更新，兼顾速度与新鲜度 |
| network-first（导航） | HTML 入口需保证拿到最新页面，离线时才回退缓存 |
| 扩展仅做注册器 | 缓存逻辑与扩展解耦，SW 可独立于扩展被任意酒馆复用 |
| 单一持久桶 + LRU | 升级不整桶清空，容量可控，避免缓存膨胀 |
| 预缓存清单可选 | 增强冷启动，缺失时优雅降级，保持通用性 |
| MutationObserver 兜底 | 应对酒馆扩展设置 DOM 动态重建/延迟挂载 |

## 10. 部署方式

两步：复制 `service-worker.js` 到 `public/` 根目录 + 通过 GitHub 链接安装扩展（见 README）。

## 11. 调试方法

1. **确认扩展 JS 已加载**：DevTools → Network 搜扩展的 `index.js`，或在 Console 看 `[SW Cache]` 日志。
2. **确认面板已注入**：Console 执行 `document.getElementById('sw-cache-panel')` 是否非空。
3. **确认 SW 已注册**：DevTools → Application → Service Workers，或 Console 执行 `navigator.serviceWorker.getRegistration('/service-worker.js')`。
4. **确认 SW 已接管**：`navigator.serviceWorker.controller` 是否非空；首次注册后需刷新一次页面才接管。
5. **确认缓存命中**：Application → Cache Storage → 查看 `st-static` 下的条目。
6. **排查面板时序**：扩展 JS 是异步加载的，检查时机需等待加载完成（等待 2-3 秒后再查）。

## 12. 已知限制

- **HTTPS 强制**：SW 仅在安全上下文（HTTPS 或 localhost）可用，HTTP 环境自动降级。
- **首次不加速**：缓存是「先访问后缓存」，从第二次访问才开始提速。
- **SW 更新有延迟**：SW 文件字节变化后，浏览器需重新下载，新版本在下次导航时接管。
- **容量上限为内存态**：SW 的 `cacheLimit` 存于内存，SW 被浏览器回收后回默认值（页面加载时用 `localStorage` 恢复补偿）。
- **第三方扩展不缓存**：用户安装的第三方扩展每次仍走网络（这是有意的安全设计）。

## 13. 如何扩展 / 修改

- **调整缓存范围**：修改 `service-worker.js` 的 `STATIC_PATH_PREFIXES` / `STATIC_ROOT_FILES`。
- **新增预缓存资源**：在 `PRECACHE_URLS` 追加 URL，或重新生成 `/precache-manifest.json`。
- **改缓存策略**：替换 `staleWhileRevalidate` / `networkFirst` 的实现，可引入 cache-first、runtime caching 等。
- **调整缓存上限**：修改 `DEFAULT_CACHE_LIMIT` 默认值，或通过面板设置。
- **面板新增功能**：在 `index.js` 的 `buildPanel()` 中追加按钮，并编写对应 handler。
- **新增 SW 通信消息**：在 `service-worker.js` 的 `message` 监听中新增 `data.type` 分支，并在 `index.js` 中发起对应 `postMessage`。
