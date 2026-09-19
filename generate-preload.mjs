/*
 * generate-preload.mjs — 构建期生成预缓存清单
 *
 * 用途：扫描 SillyTavern public/ 目录，从入口模块（script.js / lib.js）出发，
 *       递归解析静态 import 依赖，生成 /precache-manifest.json，供 Service Worker
 *       在 install 阶段一次性预缓存全部核心资源（而非只缓存几个入口文件）。
 *
 * 说明：
 *   - 仅收集「同源相对/绝对路径」的静态 import，忽略动态 import()、URL 变量、跨域。
 *   - 始终追加基础入口资源（index.html、css、根级静态文件等）。
 *   - 不收集第三方扩展目录、用户数据目录。
 *
 * 用法：
 *   node generate-preload.mjs <publicDir> [outputFile]
 *   默认 <publicDir> = ./public，outputFile = <publicDir>/precache-manifest.json
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PUBLIC_DIR = process.argv[2] || './public';
const OUTPUT_FILE = process.argv[3] || path.join(PUBLIC_DIR, 'precache-manifest.json');

// 入口模块（相对 public/ 根）
const ENTRY_MODULES = ['script.js', 'lib.js'];

// 固定追加的基础入口资源
const BASE_URLS = [
    '/',
    '/index.html',
    '/style.css',
    '/manifest.json',
    '/robots.txt',
    '/favicon.ico',
];

// 额外静态目录（整目录预缓存，避免逐文件解析 import 中的非 JS 资源）
const STATIC_DIRS = ['css', 'lib', 'locales', 'webfonts', 'sounds', 'img'];

// 必须排除的目录（用户数据 / 第三方扩展）
const EXCLUDE_PREFIXES = [
    'scripts/extensions/third-party',
    'scripts/extensions', // 内置扩展也由酒馆动态加载，按需缓存；此处保守排除全部扩展
    'backgrounds',
    'characters',
    'user',
    'assets',
];

// 只跟踪 .js 模块的 import 依赖
const seen = new Set();

/** 递归扫描 .js 文件中的静态 import 路径 */
function collectImports(content, fromDir) {
    const results = [];
    // 匹配静态 import，不匹配动态 import()（无括号前缀）
    const re = /\bimport\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        results.push(m[1]);
    }
    return results;
}

/** 将 import 说明符解析为相对 public/ 根的路径（仅处理相对路径） */
function resolveSpecifier(spec, fromDir) {
    if (!spec.startsWith('.')) return null; // 跳过裸模块/跨域/URL
    const abs = path.resolve(fromDir, spec);
    return abs;
}

/** 递归收集某个模块（public 内绝对路径）及其依赖 */
async function walkModule(absPath) {
    if (seen.has(absPath)) return;
    seen.add(absPath);

    let content;
    try {
        content = await readFile(absPath, 'utf8');
    } catch {
        return;
    }

    const fromDir = path.dirname(absPath);
    const specs = collectImports(content);

    for (const spec of specs) {
        const resolved = resolveSpecifier(spec, fromDir);
        if (!resolved) continue;
        if (!existsSync(resolved)) continue;

        const rel = path.relative(PUBLIC_DIR, resolved);
        if (!rel || rel.startsWith('..')) continue; // 超出 public 目录
        if (EXCLUDE_PREFIXES.some((p) => rel.split(path.sep).join('/').startsWith(p))) continue;

        // 只递归 JS 模块（其余资源不解析 import）
        if (resolved.endsWith('.js')) {
            await walkModule(resolved);
        }
    }
}

/** 递归收集目录下所有文件（用于整目录预缓存） */
async function walkDir(dir, base) {
    const files = [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return files;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(base, full).split(path.sep).join('/');
        if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) continue;
        if (entry.isDirectory()) {
            files.push(...(await walkDir(full, base)));
        } else {
            files.push(rel);
        }
    }
    return files;
}

/** 将 public 相对路径规范为 URL（以 / 开头） */
function toUrl(rel) {
    const normalized = rel.split(path.sep).join('/');
    return normalized.startsWith('/') ? normalized : '/' + normalized;
}

async function main() {
    const pubAbs = path.resolve(PUBLIC_DIR);

    // 1. 从入口模块递归收集 import 依赖
    const entryRelSet = new Set();
    for (const entry of ENTRY_MODULES) {
        const abs = path.join(pubAbs, entry);
        if (existsSync(abs)) {
            await walkModule(abs);
            entryRelSet.add(entry);
        }
    }
    // 把递归收集到的所有模块（含入口）都纳入清单
    for (const abs of [...seen]) {
        const rel = path.relative(pubAbs, abs).split(path.sep).join('/');
        if (rel && !rel.startsWith('..')) entryRelSet.add(rel);
    }

    // 2. 整目录静态资源
    const staticFiles = new Set();
    for (const dir of STATIC_DIRS) {
        const absDir = path.join(pubAbs, dir);
        if (!existsSync(absDir)) continue;
        const files = await walkDir(absDir, pubAbs);
        for (const f of files) staticFiles.add(f);
    }

    // 3. 汇总 URL，去重排序
    const urlSet = new Set();
    for (const rel of entryRelSet) urlSet.add(toUrl(rel));
    for (const rel of staticFiles) urlSet.add(toUrl(rel));
    for (const url of BASE_URLS) urlSet.add(url);

    const urls = [...urlSet].sort();

    // 4. 写 manifest
    const manifest = { urls };
    await writeFile(OUTPUT_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`[precache] 已生成 ${OUTPUT_FILE}，共 ${urls.length} 个 URL`);
}

main().catch((err) => {
    console.error('[precache] 生成失败：', err);
    process.exit(1);
});
