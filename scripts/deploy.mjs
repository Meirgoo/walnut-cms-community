#!/usr/bin/env node
/**
 * Walnut CMS - Zero-Dependency Interactive Cloudflare Deployment & Upgrade Wizard
 * Supports bilingual UI (zh / en) via --lang=zh|en, WALNUT_LANG, LANG, or system Intl locale.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { syncThemesToR2 } from './sync-theme-assets.mjs';

function detectLocale() {
    const langArg = process.argv.find((a) => a.startsWith('--lang='));
    const raw = (
        (langArg ? langArg.slice('--lang='.length) : '') ||
        process.env.WALNUT_LANG ||
        process.env.LC_ALL ||
        process.env.LANG ||
        Intl.DateTimeFormat().resolvedOptions().locale ||
        'en'
    ).toLowerCase();
    return raw.startsWith('zh') ? 'zh' : 'en';
}

const LOCALE = detectLocale();

const I18N = {
    zh: {
        banner: '\n🌰 Walnut CMS 交互式部署与升级向导 (Cloudflare Workers + D1 + R2)\n',
        missing_wrangler_json: '❌ 未在当前目录找到 wrangler.jsonc，请在解压后的发行包根目录运行 node deploy.mjs。',
        checking_auth: '🔍 正在检测 Cloudflare Wrangler 登录状态...',
        auth_ok: '✅ 已登录 Cloudflare 账号。',
        auth_missing: '⚠️ 当前尚未登录 Cloudflare，请先完成授权登录。',
        ask_login: '是否立即启动 `npx wrangler login` 进行登录？(Y/n): ',
        login_aborted: '❌ 已取消部署，请先手动执行 `npx wrangler login` 后重试。',
        ask_worker_name: '请输入 Worker 服务名称 (默认 {name}): ',
        d1_scanning: '\n📦 正在查询账号下已有的 D1 数据库...',
        d1_select_prompt: '请选择 D1 数据库模式:\n  [0] 新建一个 D1 数据库\n{list}\n请输入编号 (默认 0): ',
        d1_ask_new_name: '请输入新建 D1 数据库名称 (默认 {name}): ',
        d1_creating: '🚀 正在创建 D1 数据库 "{name}"...',
        d1_created: '✅ 已创建并绑定 D1 数据库: {name} ({id})',
        d1_linked: '✅ 已关联既有 D1 数据库 (升级/重装保留数据): {name} ({id})',
        d1_create_failed: '❌ 创建或解析 D1 数据库失败，请检查 Wrangler 权限或手动填写 wrangler.jsonc。',
        r2_checking: '\n🪣 正在检查 R2 存储桶配置...',
        r2_reused: '✅ 复用已有 R2 存储桶: {name}',
        r2_creating: '🚀 正在创建缺失的 R2 存储桶: {name}...',
        r2_created: '✅ 已创建 R2 存储桶: {name}',
        r2_warn: '⚠️ R2 存储桶 "{name}" 检查/创建跳过（若尚未开通 R2，请先在 Cloudflare 控制台启用 R2）: {msg}',
        r2_syncing_themes: '\n🎨 正在上传预置主题静态资源到 R2 存储桶 ({name})...',
        r2_sync_themes_ok: '✅ 已同步 {count} 个预置主题静态资源至 R2 (/theme/*)。',
        r2_sync_themes_warn: '⚠️ 预置主题资源上传 R2 失败，可稍后手动运行 `node sync-theme-assets.mjs --remote`: {msg}',
        cf_access_team_prompt: '\n🛡️ [首次初始化必填] Cloudflare Zero Trust Access Team Name (当前: {cur}，如 myteam): ',
        cf_access_aud_prompt: '🛡️ [可选] Cloudflare Access Application AUD Tag (当前: {cur}，留空跳过): ',
        cf_access_enabled: '✅ 已启用生产环境 Cloudflare Access JWT 强验签: {team}',
        cf_access_missing_warn: '⚠️ 未设置 CF_ACCESS_TEAM_NAME：生产环境首次访问 /admin/setup 将严格返回 403，请配置 Zero Trust Access 后填写此项。',
        secret_checking: '\n🔐 正在检测 Worker 密钥 ({key})...',
        secret_preserved: '✅ 检测到已存在 {key}，已保留既有密钥（不会覆盖现有会话/令牌）。',
        secret_creating: '🔑 未检测到 {key}，正在生成高强度随机密钥并写入 Cloudflare Secrets...',
        secret_created: '✅ 已安全写入 {key}。',
        secret_warn: '⚠️ 写入 {key} 失败（首次部署前可先部署一次再执行 `npx wrangler secret put {key}`）。',
        migrating: '\n🗄️ 正在增量执行远程 D1 数据库迁移 (`wrangler d1 migrations apply --remote`)...',
        migrate_ok: '✅ 远程 D1 数据库迁移完成。',
        deploying: '\n🚀 正在部署 Walnut CMS 到 Cloudflare Workers...',
        deploy_ok: '\n🎉 部署完成！请访问上方输出的 *.workers.dev 地址完成或进入站点管理。',
        aborted: '\n❌ 部署过程已中断。'
    },
    en: {
        banner: '\n🌰 Walnut CMS Interactive Deployment & Upgrade Wizard (Cloudflare Workers + D1 + R2)\n',
        missing_wrangler_json: '❌ wrangler.jsonc not found in current directory. Please run `node deploy.mjs` inside the extracted release root.',
        checking_auth: '🔍 Checking Cloudflare Wrangler authentication...',
        auth_ok: '✅ Authenticated with Cloudflare.',
        auth_missing: '⚠️ Not logged in to Cloudflare yet.',
        ask_login: 'Run `npx wrangler login` now? (Y/n): ',
        login_aborted: '❌ Deployment cancelled. Run `npx wrangler login` manually and try again.',
        ask_worker_name: 'Enter Worker name (default {name}): ',
        d1_scanning: '\n📦 Listing existing D1 databases...',
        d1_select_prompt: 'Select D1 database mode:\n  [0] Create a new D1 database\n{list}\nEnter choice (default 0): ',
        d1_ask_new_name: 'Enter new D1 database name (default {name}): ',
        d1_creating: '🚀 Creating D1 database "{name}"...',
        d1_created: '✅ Created and bound D1 database: {name} ({id})',
        d1_linked: '✅ Linked existing D1 database (upgrade preserves data): {name} ({id})',
        d1_create_failed: '❌ Failed to create or parse D1 database. Please check Wrangler permissions or edit wrangler.jsonc manually.',
        r2_checking: '\n🪣 Checking R2 buckets...',
        r2_reused: '✅ Reusing existing R2 bucket: {name}',
        r2_creating: '🚀 Creating missing R2 bucket: {name}...',
        r2_created: '✅ Created R2 bucket: {name}',
        r2_warn: '⚠️ Skipped R2 bucket "{name}" (ensure R2 is enabled in Cloudflare Dashboard): {msg}',
        r2_syncing_themes: '\n🎨 Uploading preset theme static assets to R2 bucket ({name})...',
        r2_sync_themes_ok: '✅ Uploaded {count} preset theme asset(s) to R2 (/theme/*).',
        r2_sync_themes_warn: '⚠️ Failed to upload preset theme assets to R2; run `node sync-theme-assets.mjs --remote` manually: {msg}',
        cf_access_team_prompt: '\n🛡️ [Required for Setup] Cloudflare Zero Trust Access Team Name (current: {cur}, e.g. myteam): ',
        cf_access_aud_prompt: '🛡️ [Optional] Cloudflare Access Application AUD Tag (current: {cur}, Enter to skip): ',
        cf_access_enabled: '✅ Enabled production Cloudflare Access JWT verification: {team}',
        cf_access_missing_warn: '⚠️ CF_ACCESS_TEAM_NAME is unset: /admin/setup will strictly return 403 in production until Zero Trust Access is configured.',
        secret_checking: '\n🔐 Checking Worker secret ({key})...',
        secret_preserved: '✅ Existing {key} detected and preserved (sessions/tokens remain valid).',
        secret_creating: '🔑 {key} not found. Generating and uploading a secure random secret...',
        secret_created: '✅ Uploaded {key} to Cloudflare Secrets.',
        secret_warn: '⚠️ Could not upload {key} yet (you can run `npx wrangler secret put {key}` after initial deploy).',
        migrating: '\n🗄️ Applying incremental remote D1 migrations (`wrangler d1 migrations apply --remote`)...',
        migrate_ok: '✅ Remote D1 migrations applied.',
        deploying: '\n🚀 Deploying Walnut CMS to Cloudflare Workers...',
        deploy_ok: '\n🎉 Deployment complete! Visit the *.workers.dev URL printed above.',
        aborted: '\n❌ Deployment aborted.'
    }
};

function msg(key, vars = {}) {
    let text = I18N[LOCALE][key] || I18N.en[key] || key;
    for (const [k, v] of Object.entries(vars)) {
        text = text.replaceAll(`{${k}}`, String(v));
    }
    return text;
}

function stripJsonComments(raw) {
    return raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

function runWranglerCapture(args) {
    return execFileSync('npx', ['wrangler', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function runWranglerInteractive(args, inputStr) {
    const res = spawnSync('npx', ['wrangler', ...args], {
        stdio: inputStr !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit',
        input: inputStr,
        encoding: 'utf8'
    });
    if (res.status !== 0) {
        throw new Error(`wrangler ${args.join(' ')} exited with code ${res.status}`);
    }
}

async function main() {
    console.log(msg('banner'));

    const wranglerPath = path.resolve(process.cwd(), 'wrangler.jsonc');
    if (!fs.existsSync(wranglerPath)) {
        console.error(msg('missing_wrangler_json'));
        process.exit(1);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
        // 1. Auto-detect Wrangler login
        console.log(msg('checking_auth'));
        let authed = false;
        try {
            const whoami = runWranglerCapture(['whoami']);
            if (whoami && !/not authenticated|please run.*login/i.test(whoami)) {
                authed = true;
            }
        } catch {
            authed = false;
        }

        if (authed) {
            console.log(msg('auth_ok'));
        } else {
            console.log(msg('auth_missing'));
            const ans = (await rl.question(msg('ask_login'))).trim().toLowerCase();
            if (ans === 'n' || ans === 'no') {
                console.error(msg('login_aborted'));
                process.exit(1);
            }
            runWranglerInteractive(['login']);
        }

        const wranglerConfig = JSON.parse(stripJsonComments(fs.readFileSync(wranglerPath, 'utf8')));

        // 2. Worker name
        const defaultWorkerName = wranglerConfig.name || 'walnut';
        const chosenWorkerName = (await rl.question(msg('ask_worker_name', { name: defaultWorkerName }))).trim() || defaultWorkerName;
        wranglerConfig.name = chosenWorkerName;

        // 3. D1 Database: list existing or create new
        console.log(msg('d1_scanning'));
        let existingD1s = [];
        try {
            const rawList = runWranglerCapture(['d1', 'list', '--json']);
            const parsed = JSON.parse(rawList);
            if (Array.isArray(parsed)) existingD1s = parsed;
        } catch {
            existingD1s = [];
        }

        const listText = existingD1s
            .map((db, idx) => `  [${idx + 1}] ${db.name} (${db.uuid || db.id || ''})`)
            .join('\n');
        const choiceRaw = (await rl.question(msg('d1_select_prompt', { list: listText || '  (none)' }))).trim();
        const choiceIdx = choiceRaw ? Number.parseInt(choiceRaw, 10) : 0;

        let targetDbName = '';
        let targetDbId = '';

        if (Number.isFinite(choiceIdx) && choiceIdx >= 1 && choiceIdx <= existingD1s.length) {
            const picked = existingD1s[choiceIdx - 1];
            targetDbName = picked.name;
            targetDbId = picked.uuid || picked.id || '';
            console.log(msg('d1_linked', { name: targetDbName, id: targetDbId }));
        } else {
            const defDbName = `${chosenWorkerName}-db`;
            targetDbName = (await rl.question(msg('d1_ask_new_name', { name: defDbName }))).trim() || defDbName;
            console.log(msg('d1_creating', { name: targetDbName }));
            try {
                const createOut = runWranglerCapture(['d1', 'create', targetDbName]);
                const uuidMatch = createOut.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                targetDbId = uuidMatch ? uuidMatch[0] : '';
                if (!targetDbId) {
                    const refreshed = JSON.parse(runWranglerCapture(['d1', 'list', '--json']));
                    const found = Array.isArray(refreshed) ? refreshed.find((d) => d.name === targetDbName) : null;
                    targetDbId = found?.uuid || found?.id || '';
                }
                if (!targetDbId) throw new Error('missing database_id');
                console.log(msg('d1_created', { name: targetDbName, id: targetDbId }));
            } catch (err) {
                console.error(msg('d1_create_failed'), err?.message || '');
                process.exit(1);
            }
        }

        if (!Array.isArray(wranglerConfig.d1_databases) || wranglerConfig.d1_databases.length === 0) {
            wranglerConfig.d1_databases = [{ binding: 'DB', database_name: targetDbName, database_id: targetDbId, migrations_dir: 'migrations' }];
        } else {
            wranglerConfig.d1_databases[0].database_name = targetDbName;
            wranglerConfig.d1_databases[0].database_id = targetDbId;
            if (!wranglerConfig.d1_databases[0].migrations_dir) {
                wranglerConfig.d1_databases[0].migrations_dir = 'migrations';
            }
        }

        // Write updated wrangler.jsonc before migrations/deploy
        fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, 2) + '\n', 'utf8');

        // 4. R2 Buckets: reuse existing or create missing
        console.log(msg('r2_checking'));
        let existingBuckets = new Set();
        try {
            const rawR2 = runWranglerCapture(['r2', 'bucket', 'list', '--json']);
            const parsedR2 = JSON.parse(rawR2);
            if (Array.isArray(parsedR2)) {
                for (const b of parsedR2) {
                    if (b?.name) existingBuckets.add(b.name);
                }
            }
        } catch {
            try {
                const txtR2 = runWranglerCapture(['r2', 'bucket', 'list']);
                for (const m of txtR2.matchAll(/name:\s*([^\s\n]+)/gi)) {
                    existingBuckets.add(m[1]);
                }
            } catch {}
        }

        for (const r2Entry of wranglerConfig.r2_buckets || []) {
            const bName = r2Entry?.bucket_name;
            if (!bName) continue;
            if (existingBuckets.has(bName)) {
                console.log(msg('r2_reused', { name: bName }));
            } else {
                console.log(msg('r2_creating', { name: bName }));
                try {
                    runWranglerCapture(['r2', 'bucket', 'create', bName]);
                    console.log(msg('r2_created', { name: bName }));
                } catch (err) {
                    console.warn(msg('r2_warn', { name: bName, msg: err?.message || '' }));
                }
            }
        }

        // 4.5 Sync preset theme static assets (themes/*) into primary R2 bucket
        const primaryBucketName = wranglerConfig?.r2_buckets?.[0]?.bucket_name;
        const themesDir = path.resolve(process.cwd(), 'themes');
        if (primaryBucketName && fs.existsSync(themesDir)) {
            console.log(msg('r2_syncing_themes', { name: primaryBucketName }));
            try {
                const uploadedCount = syncThemesToR2({ themesDir, bucketName: primaryBucketName, remote: true });
                console.log(msg('r2_sync_themes_ok', { count: uploadedCount }));
            } catch (err) {
                console.warn(msg('r2_sync_themes_warn', { msg: err?.message || '' }));
            }
        }

        // 5. Preserve existing JWT_SECRET / SESSION_SECRET or generate new
        const secretKeyName = 'SESSION_SECRET';
        console.log(msg('secret_checking', { key: secretKeyName }));
        let hasSecret = false;
        try {
            const secRaw = runWranglerCapture(['secret', 'list', '--name', chosenWorkerName, '--json']);
            const secList = JSON.parse(secRaw);
            if (Array.isArray(secList)) {
                hasSecret = secList.some((s) => s?.name === secretKeyName || s?.name === 'JWT_SECRET');
            }
        } catch {
            hasSecret = false;
        }

        if (hasSecret) {
            console.log(msg('secret_preserved', { key: secretKeyName }));
        } else {
            console.log(msg('secret_creating', { key: secretKeyName }));
            const randomSecret = crypto.randomBytes(32).toString('base64url');
            try {
                runWranglerInteractive(['secret', 'put', secretKeyName, '--name', chosenWorkerName], `${randomSecret}\n`);
                console.log(msg('secret_created', { key: secretKeyName }));
            } catch {
                console.warn(msg('secret_warn', { key: secretKeyName }));
            }
        }

        // 5b. Production ENVIRONMENT lock & optional Cloudflare Zero Trust Access vars
        wranglerConfig.vars = wranglerConfig.vars || {};
        wranglerConfig.vars.ENVIRONMENT = 'production';
        const curTeam = wranglerConfig.vars.CF_ACCESS_TEAM_NAME || '(none)';
        const teamAns = (await rl.question(msg('cf_access_team_prompt', { cur: curTeam }))).trim();
        if (teamAns) {
            wranglerConfig.vars.CF_ACCESS_TEAM_NAME = teamAns;
            const curAud = wranglerConfig.vars.CF_ACCESS_AUD || '(none)';
            const audAns = (await rl.question(msg('cf_access_aud_prompt', { cur: curAud }))).trim();
            if (audAns) wranglerConfig.vars.CF_ACCESS_AUD = audAns;
        }
        if (wranglerConfig.vars.CF_ACCESS_TEAM_NAME) {
            console.log(msg('cf_access_enabled', { team: wranglerConfig.vars.CF_ACCESS_TEAM_NAME }));
        } else {
            console.warn(msg('cf_access_missing_warn'));
        }
        fs.writeFileSync(wranglerPath, JSON.stringify(wranglerConfig, null, 2) + '\n', 'utf8');

        // 6. Incremental remote D1 migrations
        console.log(msg('migrating'));
        runWranglerInteractive(['d1', 'migrations', 'apply', targetDbName, '--remote']);
        console.log(msg('migrate_ok'));

        // 7. Deploy Worker
        console.log(msg('deploying'));
        runWranglerInteractive(['deploy']);
        console.log(msg('deploy_ok'));
    } finally {
        rl.close();
    }
}

main().catch((err) => {
    console.error(msg('aborted'), err?.message || err);
    process.exit(1);
});
