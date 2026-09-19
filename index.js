/*
 * SW Cache 加速 — 扩展部分
 *
 * 职责：
 *   1. 检测 public/ 根目录是否存在 service-worker.js
 *   2. 存在 → 注册 Service Worker，全站静态资源缓存生效
 *   3. 不存在 → 明确提示用户「请将 service-worker.js 放入 public/ 根目录」，优雅降级
 *   4. 在「扩展设置」里注入可展开面板：状态、命中率/容量统计、缓存上限设置、
 *      手动注册/注销、清空缓存、更新提示
 *
 * 安装要求（两步）：
 *   1. 从 GitHub 仓库下载 service-worker.js，放到 SillyTavern 的 public/ 根目录
 *   2. 在酒馆里通过 GitHub 链接安装本扩展
 *
 * 设计原则：
 *   - 幂等：重复加载不会重复注册（浏览器对同一 SW 的 register 调用天然幂等）
 *   - 健壮：任何一步失败都静默降级，绝不影响 SillyTavern 正常功能
 *   - 无侵入：不修改酒馆任何源码，不依赖任何私有 API
 *   - 通用：只依赖酒馆公共的全局对象（toastr），官方版与任意 fork 均可用
 */

(function () {
    'use strict';

    const SW_URL = '/service-worker.js';
    const PANEL_ID = 'sw-cache-panel';
    const LIMIT_STORAGE_KEY = 'swCacheLimitBytes';
    const DEFAULT_LIMIT_MB = 50;

    /* ── 通用小工具 ─────────────────────────────────────────── */

    /**
     * 安全地弹出提示。优先使用酒馆自带的 toastr，不存在则回退 console。
     */
    function notify(message, type) {
        if (typeof toastr !== 'undefined' && typeof toastr[type] === 'function') {
            toastr[type](message, 'SW Cache', { timeOut: 8000 });
        } else {
            console[type === 'error' ? 'warn' : 'info']('[SW Cache] ' + message);
        }
    }

    /** 浏览器是否具备 SW 能力（需 HTTPS 安全上下文）。 */
    function isServiceWorkerCapable() {
        return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;
    }

    /** 字节数格式化。 */
    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        let value = bytes;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i += 1;
        }
        return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[i];
    }

    /** 读取用户设置的缓存上限（MB），默认 50MB。 */
    function getSavedLimitMb() {
        try {
            const mb = Number(localStorage.getItem(LIMIT_STORAGE_KEY));
            if (Number.isFinite(mb) && mb > 0) return mb;
        } catch { }
        return DEFAULT_LIMIT_MB;
    }

    /** 保存缓存上限（MB）。 */
    function saveLimitMb(mb) {
        try {
            localStorage.setItem(LIMIT_STORAGE_KEY, String(mb));
        } catch { }
    }

    /**
     * 检测根目录的 service-worker.js 是否存在。
     * 使用 HEAD 请求，返回 true/false，任何异常都视为「不存在」。
     */
    async function swFileExists() {
        try {
            let response = await fetch(SW_URL, { method: 'HEAD', cache: 'no-store' });
            // 某些服务器不支持 HEAD（返回 405），回退到 GET 探测
            if (response.status === 405) {
                response = await fetch(SW_URL, { method: 'GET', cache: 'no-store' });
            }
            return response.ok;
        } catch {
            return false;
        }
    }

    /** 查询当前已注册的 SW（可能为 undefined）。 */
    function getRegistration() {
        if (!isServiceWorkerCapable()) {
            return Promise.resolve(undefined);
        }
        return navigator.serviceWorker.getRegistration(SW_URL);
    }

    /** 获取当前激活的 worker（可能为 undefined）。 */
    async function getActiveWorker() {
        const registration = await getRegistration();
        return registration && registration.active;
    }

    /* ── Service Worker 注册 / 注销 ─────────────────────────── */

    async function registerServiceWorker() {
        if (!isServiceWorkerCapable()) {
            console.debug('[SW Cache] 非安全上下文或浏览器不支持，无法注册');
            return false;
        }

        try {
            const registration = await navigator.serviceWorker.register(SW_URL);
            console.info('[SW Cache] Service Worker 已注册，作用域：', registration.scope);
            attachUpdateListener(registration);
            return true;
        } catch (error) {
            console.warn('[SW Cache] Service Worker 注册失败', error);
            return false;
        }
    }

    async function unregisterServiceWorker() {
        const registration = await getRegistration();
        if (!registration) {
            return false;
        }
        const unregistered = await registration.unregister();
        return Boolean(unregistered);
    }

    /* ── 与 SW 通信 ─────────────────────────────────────────── */

    /**
     * 向激活的 SW 发送消息并等待回复（带超时）。
     * @param {object} message 消息体
     * @param {number} timeoutMs 超时毫秒
     * @returns {Promise<object|undefined>} 回复数据，超时/失败返回 undefined
     */
    async function sendMessage(message, timeoutMs = 3000) {
        const worker = await getActiveWorker();
        if (!worker) return undefined;

        return new Promise((resolve) => {
            const channel = new MessageChannel();
            const timeout = setTimeout(() => {
                channel.port1.onmessage = null;
                resolve(undefined);
            }, timeoutMs);

            channel.port1.onmessage = (event) => {
                clearTimeout(timeout);
                resolve(event.data);
            };

            try {
                worker.postMessage(message, [channel.port2]);
            } catch (error) {
                clearTimeout(timeout);
                resolve(undefined);
            }
        });
    }

    /** 清空 SW 缓存。 */
    async function clearCache() {
        const worker = await getActiveWorker();
        if (!worker) {
            notify('暂无已激活的 Service Worker，请先注册或刷新页面后重试', 'warning');
            return false;
        }
        const reply = await sendMessage({ type: 'clear-cache' });
        return Boolean(reply && reply.type === 'clear-cache-done');
    }

    /** 拉取缓存统计信息。 */
    async function getStats() {
        const reply = await sendMessage({ type: 'get-stats' });
        return reply && reply.type === 'stats' ? reply : undefined;
    }

    /** 设置缓存容量上限（字节）。 */
    async function setCacheLimit(bytes) {
        const reply = await sendMessage({ type: 'set-cache-limit', bytes });
        return reply && reply.type === 'set-cache-limit-done' ? reply : undefined;
    }

    /* ── 更新提示 ───────────────────────────────────────────── */

    /** 注册后监听 SW 更新事件，提示用户有新版可接管。 */
    function attachUpdateListener(registration) {
        if (!registration || registration.__swCacheUpdateBound) return;

        // 标记避免同一 registration 重复绑定
        registration.__swCacheUpdateBound = true;

        registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    // 有新版本 SW 已就绪，但尚未接管当前页面
                    if (updateNoticeEl) {
                        updateNoticeEl.textContent = '检测到新版本缓存，刷新后生效';
                    }
                    notify('检测到新版本 Service Worker，刷新页面后生效', 'info');
                }
            });
        });
    }

    /* ── 设置面板 ───────────────────────────────────────────── */

    function getExtensionsHost() {
        return (
            document.getElementById('extensions_settings') ||
            document.getElementById('extensions_settings2') ||
            null
        );
    }

    let statusEl = null;
    let statsEl = null;
    let updateNoticeEl = null;
    let limitInputEl = null;

    /** 更新面板状态行。 */
    async function refreshPanelStatus() {
        if (!statusEl) return;

        const registration = await getRegistration();
        const hasController = Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);

        if (!isServiceWorkerCapable()) {
            statusEl.textContent = '不可用：需要 HTTPS 安全上下文';
            return;
        }

        if (registration && registration.active) {
            statusEl.textContent = `已激活${hasController ? '' : '（刷新后接管当前页面）'}`;
        } else if (registration) {
            statusEl.textContent = '已注册（尚未激活）';
        } else {
            statusEl.textContent = '未注册';
        }
    }

    /** 更新统计行。 */
    async function refreshStats() {
        if (!statsEl) return;
        const stats = await getStats();
        if (!stats) {
            statsEl.textContent = '统计：暂无数据（需已激活的 SW）';
            return;
        }

        const total = stats.hits + stats.misses;
        const hitRate = total > 0 ? ((stats.hits / total) * 100).toFixed(1) : '0.0';
        statsEl.textContent =
            `统计：命中 ${stats.hits} / 未命中 ${stats.misses}（命中率 ${hitRate}%）` +
            ` · 缓存 ${formatBytes(stats.totalBytes)}（${stats.count} 项）` +
            ` · 上限 ${formatBytes(stats.cacheLimit)}`;
    }

    function createButton(label, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu_button';
        btn.style.cssText = 'padding:6px 12px;font-size:0.85em;white-space:nowrap;';
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    async function onRegisterClick() {
        const exists = await swFileExists();
        if (!exists) {
            notify('未检测到 service-worker.js，请将其放入 public/ 根目录', 'warning');
            return;
        }
        const ok = await registerServiceWorker();
        if (ok) {
            notify('Service Worker 已注册，刷新页面后缓存生效', 'success');
        } else {
            notify('注册失败，请查看控制台', 'error');
        }
        await refreshPanelStatus();
        await refreshStats();
    }

    async function onUnregisterClick() {
        const ok = await unregisterServiceWorker();
        notify(ok ? 'Service Worker 已注销' : '未找到已注册的 Service Worker', ok ? 'success' : 'warning');
        await refreshPanelStatus();
        await refreshStats();
    }

    async function onClearCacheClick() {
        const ok = await clearCache();
        notify(ok ? '静态缓存已清空，下次访问将重新拉取' : '清空失败，请稍后重试', ok ? 'success' : 'error');
        await refreshStats();
    }

    async function onApplyLimitClick() {
        const mb = Number(limitInputEl.value);
        if (!Number.isFinite(mb) || mb <= 0) {
            notify('请输入有效的缓存上限（MB，正整数）', 'warning');
            return;
        }
        const bytes = Math.round(mb * 1024 * 1024);
        const reply = await setCacheLimit(bytes);
        if (reply) {
            saveLimitMb(mb);
            notify(`缓存上限已设为 ${formatBytes(reply.cacheLimit)}`, 'success');
        } else {
            notify('设置失败，请确认 SW 已激活', 'error');
        }
        await refreshStats();
    }

    async function onRefreshStatsClick() {
        await refreshStats();
    }

    function buildPanel() {
        const drawer = document.createElement('div');
        drawer.id = PANEL_ID;
        drawer.className = 'inline-drawer';

        const header = document.createElement('div');
        header.className = 'inline-drawer-toggle inline-drawer-header';
        header.innerHTML = '<b>SW Cache 加速</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>';

        const content = document.createElement('div');
        content.className = 'inline-drawer-content';

        const inner = document.createElement('div');
        inner.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:10px;';
        content.appendChild(inner);

        const statusLine = document.createElement('div');
        statusLine.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:0.9em;';
        statusLine.innerHTML = '<span>状态：</span><span id="sw-cache-status" style="font-weight:600">检测中…</span>';
        inner.appendChild(statusLine);

        const statsLine = document.createElement('div');
        statsLine.style.cssText = 'font-size:0.82em;opacity:0.75;line-height:1.5;';
        statsLine.id = 'sw-cache-stats';
        statsLine.textContent = '统计：加载中…';
        inner.appendChild(statsLine);

        const updateNotice = document.createElement('div');
        updateNotice.style.cssText = 'font-size:0.82em;color:#f0ad4e;font-weight:600;min-height:1em;';
        updateNotice.id = 'sw-cache-update-notice';
        inner.appendChild(updateNotice);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size:0.82em;opacity:0.6;line-height:1.6;';
        desc.textContent = '首次访问后，将前端静态资源缓存到浏览器，二次访问显著提速。';
        inner.appendChild(desc);

        // 缓存上限设置
        const limitRow = document.createElement('div');
        limitRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:0.85em;';
        const limitLabel = document.createElement('span');
        limitLabel.textContent = '缓存上限(MB)：';
        limitInputEl = document.createElement('input');
        limitInputEl.type = 'number';
        limitInputEl.min = '1';
        limitInputEl.step = '1';
        limitInputEl.value = String(getSavedLimitMb());
        limitInputEl.style.cssText = 'width:80px;padding:4px 6px;font-size:0.9em;';
        limitRow.appendChild(limitLabel);
        limitRow.appendChild(limitInputEl);
        limitRow.appendChild(createButton('应用', onApplyLimitClick));
        inner.appendChild(limitRow);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
        actions.appendChild(createButton('注册 / 更新', onRegisterClick));
        actions.appendChild(createButton('注销', onUnregisterClick));
        actions.appendChild(createButton('清空缓存', onClearCacheClick));
        actions.appendChild(createButton('刷新统计', onRefreshStatsClick));
        inner.appendChild(actions);

        drawer.appendChild(header);
        drawer.appendChild(content);

        // 缓存面板内元素引用
        statusEl = drawer.querySelector('#sw-cache-status');
        statsEl = drawer.querySelector('#sw-cache-stats');
        updateNoticeEl = drawer.querySelector('#sw-cache-update-notice');

        return drawer;
    }

    function ensurePanel() {
        const host = getExtensionsHost();
        if (!(host instanceof HTMLElement)) return false;

        if (document.getElementById(PANEL_ID)) {
            void refreshPanelStatus();
            void refreshStats();
            return true;
        }

        host.appendChild(buildPanel());
        void refreshPanelStatus();
        void refreshStats();
        return true;
    }

    async function ensurePanelWithRetry() {
        for (let i = 0; i < 20; i++) {
            if (ensurePanel()) return true;
            await new Promise((r) => setTimeout(r, 300));
        }
        return false;
    }

    function initPanel() {
        if (globalThis.__swCachePanelLoaded) return;
        globalThis.__swCachePanelLoaded = true;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => { void ensurePanelWithRetry(); }, { once: true });
        } else {
            void ensurePanelWithRetry();
        }

        // 酒馆 APP 就绪后，扩展设置 DOM 可能才挂载，重试一次
        const ctx = globalThis.SillyTavern?.getContext?.();
        ctx?.eventSource?.on?.(ctx?.eventTypes?.APP_READY, () => { void ensurePanelWithRetry(); });
        ctx?.eventSource?.on?.(ctx?.eventTypes?.SETTINGS_LOADED, () => { void ensurePanelWithRetry(); });

        // 监听 DOM 变化，确保容器出现 / 面板被移除后能自动挂载；
        // 面板成功挂载后即断开观察，避免长期监听整个 body 的开销
        try {
            let rafPending = false;
            const obs = new MutationObserver(() => {
                if (rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    if (!document.getElementById(PANEL_ID)) {
                        ensurePanel();
                    } else {
                        obs.disconnect();
                    }
                });
            });
            obs.observe(document.body, { childList: true, subtree: true });
        } catch { }
    }

    /* ── 主流程 ─────────────────────────────────────────────── */

    async function init() {
        // 无论环境是否支持 SW，都注入设置面板（面板会显示具体状态/原因）
        initPanel();

        if (!isServiceWorkerCapable()) {
            console.debug('[SW Cache] 非安全上下文或浏览器不支持，跳过自动注册');
            return;
        }

        const exists = await swFileExists();

        if (!exists) {
            console.warn('[SW Cache] 未检测到 ' + SW_URL + '，请将该文件放入 SillyTavern 的 public/ 根目录');
            notify('未检测到 service-worker.js，请将其放入 public/ 根目录以启用缓存加速', 'warning');
            return;
        }

        // 已有激活的 SW 时静默，避免每次刷新重复弹提示
        const existing = await getRegistration();
        if (existing) {
            attachUpdateListener(existing);
            if (existing.active) {
                // 已激活：应用用户保存的缓存上限（SW 重启后内存态上限丢失）
                void applySavedLimit();
                return;
            }
        }

        const ok = await registerServiceWorker();
        if (ok) {
            notify('静态资源缓存已启用，下次访问将更快', 'success');
        }
    }

    /** 将用户保存的缓存上限同步到 SW（SW 内存态重启后回默认值）。 */
    async function applySavedLimit() {
        const mb = getSavedLimitMb();
        const worker = await getActiveWorker();
        if (!worker) return;
        await setCacheLimit(Math.round(mb * 1024 * 1024));
    }

    // 页面加载完成后执行，避免与酒馆首屏加载抢资源
    if (document.readyState === 'loading') {
        window.addEventListener('load', init, { once: true });
    } else {
        init();
    }
})();
