#!/usr/bin/env node
/**
 * Walnut CMS - Preset Theme R2 Asset Synchronizer
 * Collects preset theme static files under themes/<slug>/assets (excluding manifest.json and templates)
 * and uploads them to the configured Cloudflare R2 bucket under keys theme/<slug>/<relPath>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MIME_MAP = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject'
};

export function inferThemeAssetContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_MAP[ext] || 'application/octet-stream';
}

export function collectPresetThemeAssets(themesDir = path.resolve('themes')) {
    const entries = [];
    if (!fs.existsSync(themesDir)) return entries;

    const walk = (dir, themeSlug, themeRoot) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (item.name.startsWith('.') || item.name === '.DS_Store') continue;
            const fullPath = path.join(dir, item.name);
            const relInsideTheme = path.relative(themeRoot, fullPath).split(path.sep).join('/');

            if (item.isDirectory()) {
                if (relInsideTheme === 'templates') continue;
                walk(fullPath, themeSlug, themeRoot);
                continue;
            }
            if (!item.isFile()) continue;
            if (relInsideTheme === 'manifest.json' || relInsideTheme === 'tokens.json' || relInsideTheme.startsWith('templates/')) {
                continue;
            }
            entries.push({
                themeSlug,
                relPath: relInsideTheme,
                r2Key: `theme/${themeSlug}/${relInsideTheme}`,
                fullPath,
                contentType: inferThemeAssetContentType(fullPath)
            });
        }
    };

    for (const dirEntry of fs.readdirSync(themesDir, { withFileTypes: true })) {
        if (!dirEntry.isDirectory() || dirEntry.name.startsWith('.')) continue;
        const themeRoot = path.join(themesDir, dirEntry.name);
        walk(themeRoot, dirEntry.name, themeRoot);
    }

    return entries;
}

export function syncThemesToR2({ themesDir = path.resolve('themes'), bucketName, remote = true } = {}) {
    if (!bucketName) {
        throw new Error('Missing R2 bucket name for theme asset synchronization.');
    }
    const files = collectPresetThemeAssets(themesDir);
    for (const file of files) {
        const target = `${bucketName}/${file.r2Key}`;
        const args = [
            'wrangler',
            'r2',
            'object',
            'put',
            target,
            '--file',
            file.fullPath,
            '--content-type',
            file.contentType,
            remote ? '--remote' : '--local'
        ];
        execFileSync('npx', args, { stdio: 'inherit' });
    }
    return files.length;
}

/**
 * `wrangler dev` simulates the BUCKET binding with `preview_bucket_name` while `r2 object put --local`
 * writes to the literal bucket name, so a local sync must target the preview id or the dev Worker sees an empty bucket (404).
 */
export function resolveThemeSyncBucketName(wranglerConfig, { remote }) {
    const buckets = wranglerConfig?.r2_buckets || [];
    const primary = buckets.find((b) => b?.binding === 'BUCKET') || buckets[0];
    if (!primary) return '';
    return remote ? primary.bucket_name : (primary.preview_bucket_name || primary.bucket_name);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
    const isLocal = process.argv.includes('--local');
    const wranglerPath = path.resolve('wrangler.jsonc');
    const stripped = fs.readFileSync(wranglerPath, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const cfg = JSON.parse(stripped);
    const bucketName = resolveThemeSyncBucketName(cfg, { remote: !isLocal });
    if (!bucketName) {
        console.error('❌ Missing r2_buckets BUCKET binding bucket_name in wrangler.jsonc');
        process.exit(1);
    }
    const count = syncThemesToR2({ bucketName, remote: !isLocal });
    console.log(`✅ Synced ${count} preset theme asset(s) to R2 bucket "${bucketName}" (${isLocal ? 'local' : 'remote'}).`);
}
