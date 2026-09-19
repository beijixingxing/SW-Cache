# SW Cache — SillyTavern 静态资源缓存加速

让任何 SillyTavern（官方版或任意 fork）的**再次访问**从浏览器本地缓存读取前端静态资源（约 10MB 的 JS/CSS/字体/图片），大幅缩短手机等设备的二次加载时间。

## 原理

SillyTavern 前端是源码直出（`script.js` + 90 个 ES Module），首次访问需下载约 10MB 资源，且**默认没有任何 Service Worker 缓存机制**，导致手机每次访问都要全量冷加载。

本项目通过一个 **Service Worker** 把这些静态资源缓存到浏览器本地，二次访问时直接从本地读取，实现"秒开"。

## 仓库结构

```
st-sw-cache/
├── manifest.json          # 扩展清单（GitHub 链接安装必需，在仓库根目录）
├── index.js               # 扩展逻辑：检测根文件 → 注册 SW / 提示用户
├── service-worker.js      # 核心缓存逻辑（需用户放到 public/ 根目录）
└── README.md
```

## 安装（两步）

### 第一步：放置 Service Worker 文件

将本仓库的 `service-worker.js` 下载后，复制到 SillyTavern 的 `public/` 根目录：

```bash
cp service-worker.js /path/to/SillyTavern/public/service-worker.js
```

> 说明：Service Worker 的作用域由文件所在目录决定。放在 `public/` 根目录，
> 作用域才是 `/`，才能缓存 `/script.js`、`/css/`、`/lib/` 等根级资源。
> 这是浏览器规范要求，无法通过第三方扩展目录绕过。

### 第二步：通过 GitHub 链接安装扩展

在 SillyTavern 的「扩展 → 第三方扩展 → 通过 URL 安装」，粘贴本仓库的
GitHub 链接（例如 `https://github.com/<你的用户名>/st-sw-cache`），点击安装。

安装后扩展会自动：
- 检测 `public/` 根目录是否存在 `service-worker.js`
- **存在** → 注册 Service Worker，弹出「静态资源缓存已启用」提示
- **不存在** → 弹出提示「请将 service-worker.js 放入 public/ 根目录」，不影响酒馆使用

## 使用要求

- 必须通过 **HTTPS** 访问（或 localhost）。Service Worker 仅工作在安全上下文。
- 首次访问仍需完整下载（这是缓存的必经步骤）；**从第二次访问开始加速**。

## 缓存策略（安全设计）

| 请求类型 | 策略 | 说明 |
|---------|------|------|
| 导航（进入页面） | network-first | 优先网络，离线回退缓存 |
| 静态资源（白名单） | stale-while-revalidate | 先回缓存，后台静默更新 |
| `/api/*`、用户数据、第三方扩展 | **不拦截** | 直连网络，绝不缓存 |

**安全原则**：采用「静态资源白名单」，只缓存 `public/` 下的构建产物与静态文件，
绝不缓存聊天记录、用户信息、API 响应、用户目录、第三方扩展等动态/隐私数据。

## 更新缓存

采用**文件级缓存**：静态资源更新时（内容变化、URL 不变），SWR 后台会用新内容自动覆盖旧条目，
无需修改版本号、无需清空整桶。超出容量上限时按「最久未访问优先」自动淘汰单个条目。

## 功能

- **命中率与容量可视化**：扩展面板展示命中/未命中次数、命中率、已缓存大小与条目数。
- **可设置缓存上限**：面板可自定义缓存容量上限（默认 50MB），超出后按 LRU 自动淘汰。
- **更新提示**：检测到新版本 Service Worker 时，面板提示「刷新后生效」。

> 说明：若 `public/` 根目录存在 `precache-manifest.json`（可选增强，由构建期脚本生成），
> 首次预缓存会更完整；**缺失时自动退回内置最小清单，功能不受影响**。

## 常见问题

**Q：为什么第二次访问还是慢？**
确认浏览器已成功注册 SW（DevTools → Application → Service Workers），且非首次访问。

**Q：会缓存到我的聊天记录吗？**
不会。所有 `/api/*` 和用户目录路径都被排除，只缓存纯静态资源。

**Q：扩展安装后没看到缓存生效？**
本扩展只是「注册器」，真正的缓存逻辑在根目录的 `service-worker.js`。
请确认该文件已放入 `public/` 根目录（第一步），否则扩展会提示缺文件。
