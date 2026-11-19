#!/usr/bin/env node
/**
 * Walnut CMS - Edge Performance & Concurrency Benchmark Script (Native Node fetch)
 *
 * Usage:
 *   node scripts/bench.mjs [--url=http://localhost:8787] [--concurrency=25] [--duration=15] [--scenario=all|dirty|rw|ratelimit|steady] [--cookie=...] [--token=...]
 */

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const idx = a.indexOf('=');
        if (idx === -1) return [a.replace(/^--/, ''), 'true'];
        return [a.slice(0, idx).replace(/^--/, ''), a.slice(idx + 1)];
    })
);

const BASE_URL = (args.url || 'http://localhost:8787').replace(/\/+$/, '');
const CONCURRENCY = Math.max(1, Number(args.concurrency || 25));
const STEADY_SECONDS = Math.max(1, Number(args.duration || 15));
const SCENARIO = args.scenario || 'all';
const ADMIN_COOKIE = args.cookie || '';
const ECO_TOKEN = args.token || '';

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function summarize(name, latencies, errors, totalStatuses = {}) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const errRate = latencies.length + errors > 0 ? ((errors / (latencies.length + errors)) * 100).toFixed(2) : '0.00';
    console.log(`\n📊 [${name}]`);
    console.log(`   Requests : ${latencies.length + errors} | Errors: ${errors} (${errRate}%)`);
    console.log(`   P50      : ${percentile(sorted, 50).toFixed(2)} ms`);
    console.log(`   P95      : ${percentile(sorted, 95).toFixed(2)} ms`);
    console.log(`   P99      : ${percentile(sorted, 99).toFixed(2)} ms`);
    console.log(`   Statuses : ${JSON.stringify(totalStatuses)}`);
}

async function timedFetch(url, options = {}) {
    const t0 = performance.now();
    try {
        const res = await fetch(url, options);
        await res.arrayBuffer();
        return { ok: res.status < 500, status: res.status, ms: performance.now() - t0, edge: res.headers.get('X-Edge-Cache') };
    } catch {
        return { ok: false, status: 0, ms: performance.now() - t0, edge: null };
    }
}

async function triggerWrite(idx) {
    if (ECO_TOKEN) {
        return timedFetch(`${BASE_URL}/api/ecosystem/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Walnut-Ecosystem-App': 'grain',
                'Authorization': `Bearer ${ECO_TOKEN}`
            },
            body: JSON.stringify({
                content: `Bench sync payload #${idx} at ${Date.now()}`,
                source_id: `bench-sync-${idx % 5}`
            })
        });
    }
    return timedFetch(`${BASE_URL}/api/articles?limit=5`);
}

async function runDirtyStampede() {
    await triggerWrite(1);
    const latencies = [];
    let errors = 0;
    const statuses = {};
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            const r = await timedFetch(`${BASE_URL}/`);
            statuses[r.status] = (statuses[r.status] || 0) + 1;
            if (!r.ok) errors++;
            else latencies.push(r.ms);
        })
    );
    summarize('1. Dirty Cache Stampede', latencies, errors, statuses);
}

async function runReadWriteContention() {
    const latencies = [];
    let errors = 0;
    const statuses = {};
    let stop = false;

    const writer = (async () => {
        let i = 0;
        while (!stop) {
            await triggerWrite(++i);
            await new Promise((r) => setTimeout(r, 200));
        }
    })();

    const readers = Array.from({ length: Math.max(CONCURRENCY, 30) }, async () => {
        for (let k = 0; k < 10; k++) {
            const r = await timedFetch(`${BASE_URL}/articles`);
            statuses[r.status] = (statuses[r.status] || 0) + 1;
            if (!r.ok) errors++;
            else latencies.push(r.ms);
        }
    });

    await Promise.all(readers);
    stop = true;
    await writer;
    summarize('2. Read/Write Contention (30 Readers + Low-Freq Writer)', latencies, errors, statuses);
}

async function runRateLimiterWatermark() {
    const total = 2500;
    const latencies = [];
    let errors = 0;
    const statuses = {};
    let cursor = 0;

    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= total) break;
            const ip = `10.${(idx >> 16) & 255}.${(idx >> 8) & 255}.${(idx % 250) + 1}`;
            const r = await timedFetch(`${BASE_URL}/welcome`, {
                headers: { 'CF-Connecting-IP': ip }
            });
            statuses[r.status] = (statuses[r.status] || 0) + 1;
            if (!r.ok && r.status !== 429) errors++;
            else latencies.push(r.ms);
        }
    });

    if (ADMIN_COOKIE) {
        workers.push(
            (async () => {
                for (let i = 0; i < 5; i++) {
                    await timedFetch(`${BASE_URL}/admin/articles/api/export-selected`, {
                        headers: { Cookie: ADMIN_COOKIE }
                    });
                }
            })()
        );
    }

    await Promise.all(workers);
    summarize('3. Rate Limiter & Memory Watermark (2500 Random IPs)', latencies, errors, statuses);
}

async function runSteadyBaseline() {
    await timedFetch(`${BASE_URL}/welcome`);
    const latencies = [];
    let errors = 0;
    const statuses = {};
    const endAt = Date.now() + STEADY_SECONDS * 1000;

    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (Date.now() < endAt) {
                const r = await timedFetch(`${BASE_URL}/welcome`);
                statuses[r.status] = (statuses[r.status] || 0) + 1;
                if (!r.ok) errors++;
                else latencies.push(r.ms);
            }
        })
    );
    const rps = (latencies.length / STEADY_SECONDS).toFixed(1);
    summarize(`4. Hot Cache Steady Baseline (${STEADY_SECONDS}s, ~${rps} req/s)`, latencies, errors, statuses);
}

async function main() {
    console.log(`🚀 Walnut CMS Edge Bench -> ${BASE_URL} (concurrency=${CONCURRENCY}, scenario=${SCENARIO})`);
    if (SCENARIO === 'all' || SCENARIO === 'dirty') await runDirtyStampede();
    if (SCENARIO === 'all' || SCENARIO === 'rw') await runReadWriteContention();
    if (SCENARIO === 'all' || SCENARIO === 'ratelimit') await runRateLimiterWatermark();
    if (SCENARIO === 'all' || SCENARIO === 'steady') await runSteadyBaseline();
}

main().catch((err) => {
    console.error('Bench failed:', err);
    process.exit(1);
});
