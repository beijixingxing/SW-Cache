/*
 * SillyTavern Service Worker — 通用静态资源缓存加速
 *
 * 适用：SillyTavern 官方版及任意 fork（目录结构一致，可原样复用）。
 *
 * 用途：首次访问后，将前端静态资源（JS/CSS/字体/图片，约 10MB）缓存到浏览器，
 *       再次访问时从本地读取，大幅缩短手机等设备的二次加载时间。
 *
 * ── 缓存策略 ─────────────────────────────────────────────
 *  1. 导航请求（进入页面）      → network-first，网络失败回退缓存
 *  2. 静态资源（白名单路径）    → stale-while-revalidate（先回缓存，后台静默更新）
 *  3. 其余请求                  → 一律放行，直连网络，绝不缓存
 *
 * ── 安全原则（极其重要）──────────────────────────────────
 *  采用「静态资源白名单」而非「除 API 外全缓存」，确保绝不在缓存中夹带：
 *    - /api/*（聊天记录、用户信息等动态/认证数据）
 *    - /backgrounds、/characters、/assets、/user/*（用户目录）
 *    - /scripts/extensions/third-party/*（用户安装的第三方扩展，动态路由）
 *  这些路径一旦被缓存，会导致用户看到旧数据或泄漏隐私，故一律排除。
 *
 * ── 更新机制（文件级，非整桶）────────────────────────────
 *  采用单一持久缓存桶 + 按 URL 覆盖写入 + LRU 淘汰：
 *    - 静态资源更新时（内容变化、URL 不变），SWR 后台会用新内容覆盖旧条目，
 *      无需清空整桶、无需修改版本号。
 *    - 超出容量上限时，按「最久未访问优先」淘汰单个条目，而非全量清空。
 *  旧版（st-static-v*）整桶缓存在 activate 阶段自动迁移清理。
 */

/* 单一持久缓存桶：不再使用版本前缀，升级不清空 */
const STATIC_CACHE = 'st-static';

/*
 * 首次安装时预缓存的基础入口资源。
 * 若构建期生成了 /precache-manifest.json（含 script.js 全部静态 import 依赖），
 * 则优先使用该清单；否则退回此最小清单（冷启动仍可用）。
 */
const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/script.js',
    '/lib.js',
    '/style.css',
    '/manifest.json',
    '/css/bright.min.css',
    '/css/fontawesome.min.css',
    '/css/solid.min.css',
    '/css/brands.min.css',
];

/*
 * 静态资源白名单：只有匹配这些前缀的「同源 GET」才会被缓存。
 * 对应 SillyTavern 的 public/ 静态目录，内容为构建产物与静态文件，不含用户数据。
 */
const STATIC_PATH_PREFIXES = [
    '/css/',
    '/img/',
    '/lib/',
    '/locales/',
    '/webfonts/',
    '/sounds/',
];

/* /scripts/ 目录可缓存，但必须排除用户安装的第三方扩展（动态路由） */
const SCRIPTS_PREFIX = '/scripts/';
const SCRIPTS_EXCLUDE_PREFIX = '/scripts/extensions/third-party/';

/* 根级静态文件（不在子目录里的单个资源） */
const STATIC_ROOT_FILES = new Set([
    '/script.js',
    '/lib.js',
    '/style.css',
    '/favicon.ico',
    '/manifest.json',
    '/robots.txt',
]);

/* 默认缓存容量上限（字节）。可由页面通过 set-cache-limit 消息调整。 */
const DEFAULT_CACHE_LIMIT = 50 * 1024 * 1024; // 50MB

/* 当前生效的缓存上限（内存态，SW 重启后回默认值） */
let cacheLimit = DEFAULT_CACHE_LIMIT;

/* 命中率统计（会话级，SW 被浏览器回收后重置） */
const stats = { hits: 0, misses: 0, serves: 0, networkFetches: 0 };

/* LRU 访问时间记录（url → 最近命中时间戳） */
const lastUsed = new Map();

/* 周期性执行 LRU 的节流计数（每 N 次缓存写入触发一次） */
let writeCount = 0;
const LRU_THROTTLE = 50;

/**
 * 判断路径是否属于可缓存的静态资源。
 * 排除第三方扩展目录（用户数据）及一切不在白名单内的路径。
 */
function isStaticAsset(pathname) {
    if (STATIC_ROOT_FILES.has(pathname)) {
        return true;
    }
    if (pathname.startsWith(SCRIPTS_EXCLUDE_PREFIX)) {
        return false;
    }
    if (pathname.startsWith(SCRIPTS_PREFIX)) {
        return true;
    }
    return STATIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/* ── 缓存度量 ───────────────────────────────────────────── */

/** 获取单个缓存的条目数与总字节数。 */
async function getCacheMetrics(cacheName) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    let totalBytes = 0;
    for (const request of keys) {
        const response = await cache.match(request);
        if (response) {
            try {
                const blob = await response.clone().blob();
                totalBytes += blob.size;
            } catch {
                // 读取失败跳过该条目
            }
        }
    }
    return { count: keys.length, totalBytes };
}

/** 遍历缓存，淘汰最久未访问的条目，直到总大小低于上限。 */
async function enforceCacheLimit() {
    const cache = await caches.open(STATIC_CACHE);
    const keys = await cache.keys();

    // 统计每个条目大小与访问时间
    const entries = [];
    for (const request of keys) {
        const response = await cache.match(request);
        if (!response) continue;
        let size = 0;
        try {
            size = (await response.clone().blob()).size;
        } catch {
            size = 0;
        }
        entries.push({
            url: request.url,
            request,
            size,
            lastUsed: lastUsed.get(request.url) || 0,
        });
    }

    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= cacheLimit) return;

    // 最久未访问的优先淘汰
    entries.sort((a, b) => a.lastUsed - b.lastUsed);

    for (const entry of entries) {
        if (total <= cacheLimit) break;
        await cache.delete(entry.request);
        lastUsed.delete(entry.url);
        total -= entry.size;
    }
}

/* ── 生命周期 ─────────────────────────────────────────────── */

/** 读取预缓存清单：优先构建期生成的 manifest，退回内置最小清单。 */
async function resolvePrecacheUrls() {
    try {
        const response = await fetch('/precache-manifest.json', { cache: 'no-store' });
        if (response && response.ok) {
            const data = await response.json();
            if (Array.isArray(data.urls) && data.urls.length) {
                return data.urls;
            }
        }
    } catch {
        // manifest 不存在或解析失败，退回内置清单
    }
    return PRECACHE_URLS;
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(STATIC_CACHE);
            const urls = await resolvePrecacheUrls();
            await Promise.allSettled(
                urls.map((url) => cache.add(url)),
            );
            // 立即接管，无需用户关闭所有标签页
            await self.skipWaiting();
        })(),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            // 清理旧版本整桶缓存（st-static-v* 等历史桶）以及非本 SW 的桶
            await Promise.all(
                keys
                    .filter((key) => key !== STATIC_CACHE)
                    .map((key) => caches.delete(key)),
            );
            // 迁移后执行一次 LRU 淘汰
            await enforceCacheLimit();
            await self.clients.claim();
        })(),
    );
});

/* ── 策略实现 ─────────────────────────────────────────────── */

/** network-first：优先网络，失败回退缓存。用于导航（HTML 入口）。 */
async function networkFirst(request) {
    const cache = await caches.open(STATIC_CACHE);
    try {
        const response = await fetch(request);
        if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
            lastUsed.set(request.url, Date.now());
        }
        stats.networkFetches += 1;
        return response;
    } catch (error) {
        const cached = await cache.match(request);
        if (cached) {
            stats.hits += 1;
            lastUsed.set(request.url, Date.now());
            return cached;
        }
        throw error;
    }
}

/** stale-while-revalidate：命中缓存立即返回，同时后台更新。用于静态资源。 */
async function staleWhileRevalidate(request) {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);

    const networkPromise = fetch(request)
        .then((response) => {
            if (response && response.ok && response.type === 'basic') {
                cache.put(request, response.clone());
                lastUsed.set(request.url, Date.now());
                writeCount += 1;
                if (writeCount >= LRU_THROTTLE) {
                    writeCount = 0;
                    // 后台节流触发 LRU，不阻塞返回
                    enforceCacheLimit().catch(() => {});
                }
            }
            return response;
        })
        .catch(() => new Response('', { status: 504, statusText: 'Offline' }));

    if (cached) {
        stats.hits += 1;
        stats.serves += 1;
        lastUsed.set(request.url, Date.now());
        // 后台更新失败静默忽略，不影响已返回的缓存结果
        networkPromise.catch(() => {});
        return cached;
    }

    stats.misses += 1;
    return networkPromise;
}

/* ── 拦截与分派 ───────────────────────────────────────────── */

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // 只处理同源 GET；POST/PUT、跨域、WebSocket 等一律放行
    if (request.method !== 'GET') {
        return;
    }

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return;
    }

    if (url.origin !== self.location.origin) {
        return;
    }

    // 导航请求
    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
        return;
    }

    // 静态资源走 SWR
    if (isStaticAsset(url.pathname)) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    // 其余不拦截，直连网络
});

/* ── 与页面通信 ───────────────────────────────────────────── */

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') {
        return;
    }
    const replyPort = event.ports && event.ports[0];

    // 清空所有静态缓存
    if (data.type === 'clear-cache') {
        event.waitUntil(
            caches.keys()
                .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
                .then(() => {
                    lastUsed.clear();
                    if (replyPort) {
                        replyPort.postMessage({ type: 'clear-cache-done' });
                    }
                }),
        );
        return;
    }

    // 让新版本 SW 立即接管（跳过等待）
    if (data.type === 'skip-waiting') {
        self.skipWaiting();
        if (replyPort) {
            replyPort.postMessage({ type: 'skip-waiting-done' });
        }
        return;
    }

    // 返回统计信息（命中率 + 缓存容量 + 条目数 + 上限）
    if (data.type === 'get-stats') {
        event.waitUntil(
            getCacheMetrics(STATIC_CACHE)
                .then(({ count, totalBytes }) => {
                    if (replyPort) {
                        replyPort.postMessage({
                            type: 'stats',
                            count,
                            totalBytes,
                            cacheLimit,
                            hits: stats.hits,
                            misses: stats.misses,
                            serves: stats.serves,
                            networkFetches: stats.networkFetches,
                        });
                    }
                }),
        );
        return;
    }

    // 设置缓存容量上限（字节），并立即执行一次 LRU
    if (data.type === 'set-cache-limit') {
        const bytes = Number(data.bytes);
        if (Number.isFinite(bytes) && bytes > 0) {
            cacheLimit = bytes;
            event.waitUntil(
                enforceCacheLimit().then(() => {
                    if (replyPort) {
                        replyPort.postMessage({ type: 'set-cache-limit-done', cacheLimit });
                    }
                }),
            );
        } else if (replyPort) {
            replyPort.postMessage({ type: 'set-cache-limit-error' });
        }
        return;
    }
});
