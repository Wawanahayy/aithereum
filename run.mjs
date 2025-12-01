#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

const API_BASE   = process.env.AITHEREUM_API_BASE || 'https://api.aithereumnetwork.com/api';
const USERS_FILE = process.env.USERS_FILE || 'aithereum-users.txt';

const BASE_SLEEP_MS    = Number(process.env.BASE_SLEEP_MS || 3000);
const JITTER_MS        = Number(process.env.JITTER_MS || 2000);
const DRY_RUN          = String(process.env.DRY_RUN || '0') === '1';
// interval between each full run (default 24 H)
const LOOP_INTERVAL_MS = Number(process.env.LOOP_INTERVAL_MS || 240 * 60 * 1000);

const CODES_ENV = process.env.CODE || '';
const GIFT_CODES = Array.from(
  new Set(
    CODES_ENV
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
  )
);

const UA =
  process.env.UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function log(...a) {
  console.log('[aithereum]', ...a);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readUserIds(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Users file not found: ${abs}`);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  return lines;
}

function isSameUtcDate(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}


async function fetchWith429Retry(label, url, headers) {
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const res = await axios.get(url, {
        headers,
        timeout: 30000,
        validateStatus: () => true,
      });

      if (res.status === 429) {
        const sleep = 1000 + Math.floor(Math.random() * 2000);
        log(`⚠️ ${label}: 429 Too Many Requests, attempt ${attempts}/${maxAttempts}, sleeping ${sleep}ms...`);
        await wait(sleep);
        continue;
      }

      return res;
    } catch (err) {
      if (err.response && err.response.status === 429) {
        const sleep = 1000 + Math.floor(Math.random() * 2000);
        log(`⚠️ ${label}: 429 error, attempt ${attempts}/${maxAttempts}, sleeping ${sleep}ms...`);
        await wait(sleep);
        continue;
      }

      log(`❌ ${label}: network/unknown error:`, err.message);
      return null;
    }
  }

  log(`❌ ${label}: aborted after ${maxAttempts} attempts (429 Too Many Requests).`);
  return null;
}

async function fetchActiveTasks() {
  const url = `${API_BASE}/tasks/active`;
  const label = '[global] /tasks/active';

  const res = await fetchWith429Retry(label, url, {
    accept: '*/*',
    'content-type': 'application/json',
    origin: 'https://aithereumnetwork.com',
    referer: 'https://aithereumnetwork.com/',
    'user-agent': UA,
  });

  if (!res) {
    return [];
  }

  if (!res.data || !res.data.success) {
    log('⚠️ Failed to fetch /tasks/active. Status:', res.status);
    return [];
  }

  const tasks = Array.isArray(res.data.data) ? res.data.data : [];
  log(`Loaded ${tasks.length} active tasks from /tasks/active`);
  return tasks;
}

async function fetchUserTasks(userId) {
  const url = `${API_BASE}/tasks/user/${userId}`;
  const label = `[${userId}] /tasks/user`;

  const res = await fetchWith429Retry(label, url, {
    accept: '*/*',
    'content-type': 'application/json',
    origin: 'https://aithereumnetwork.com',
    referer: 'https://aithereumnetwork.com/',
    'user-agent': UA,
  });

  if (!res) {
    return [];
  }

  if (!res.data || !res.data.success) {
    log(`⚠️ [${userId}] Failed to fetch /tasks/user. Status:`, res.status);
    return [];
  }

  const tasks = Array.isArray(res.data.data) ? res.data.data : [];
  log(`[${userId}] Completed tasks count: ${tasks.length}`);
  return tasks;
}

async function fetchUser(userId) {
  const url = `${API_BASE}/users/${userId}`;
  const label = `[${userId}] /users/:id`;

  const res = await fetchWith429Retry(label, url, {
    accept: 'application/json, text/plain, */*',
    origin: 'https://aithereumnetwork.com',
    referer: 'https://aithereumnetwork.com/',
    'user-agent': UA,
  });

  if (!res) {
    return null;
  }

  if (!res.data || !res.data.success) {
    log(`⚠️ [${userId}] Failed to fetch /users/:id. Status:`, res.status);
    return null;
  }

  return res.data.data;
}

/* ---------------- POST: claimTask with 429 retry ---------------- */

async function claimTask(userId, taskType, taskName) {
  const url = `${API_BASE}/tasks/complete`;
  const payload = { userId, taskType, taskName };

  if (DRY_RUN) {
    log(
      `DRY_RUN=1 → SKIP task claim userId=${userId}, taskType=${taskType}, taskName="${taskName}"`
    );
    return { ok: true, dryRun: true };
  }

  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;

    try {
      const res = await axios.post(url, payload, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          origin: 'https://aithereumnetwork.com',
          referer: 'https://aithereumnetwork.com/',
          'user-agent': UA,
        },
        timeout: 30000,
        validateStatus: () => true,
      });

      if (res.status === 429) {
        const sleep = 1000 + Math.floor(Math.random() * 2000);
        log(
          `⚠️ [${userId}] 429 Too Many Requests for taskType=${taskType}, attempt ${attempts}/${maxAttempts}, sleeping ${sleep}ms...`
        );
        await wait(sleep);
        continue;
      }

      const body = (res.data && typeof res.data === 'object') ? res.data : {};
      const reward = body.reward ?? '?';
      const newBalance = body.newBalance ?? '?';
      const message = typeof body.message === 'string' ? body.message : '';

      if (res.status >= 200 && res.status < 300) {
        log(
          `✅ [${userId}] Task claim success: type=${taskType}, name="${taskName}", status=${res.status}, reward=${reward}, newBalance=${newBalance}, message="${message}"`
        );
        return { ok: true, status: res.status, data: body };
      } else {
        log(
          `❌ [${userId}] Task claim failed: type=${taskType}, name="${taskName}", status=${res.status}, message="${message}"`
        );
        return { ok: false, status: res.status, data: body };
      }
    } catch (err) {
      if (err.response && err.response.status === 429) {
        const sleep = 1000 + Math.floor(Math.random() * 2000);
        log(
          `⚠️ [${userId}] 429 error while claiming taskType=${taskType}, attempt ${attempts}/${maxAttempts}, sleeping ${sleep}ms...`
        );
        await wait(sleep);
        continue;
      }

      if (err.response) {
        log(
          `❌ [${userId}] Task claim error response: type=${taskType}, status=${err.response.status}`
        );
        return { ok: false, status: err.response.status, error: err.message };
      }
      log(`❌ [${userId}] Task claim network/unknown error: type=${taskType}, error=${err.message}`);
      return { ok: false, status: 0, error: err.message };
    }
  }

  log(
    `❌ [${userId}] Task claim aborted after ${maxAttempts} attempts (429 Too Many Requests) for type=${taskType}`
  );
  return { ok: false, status: 429, error: 'Too many retries (429)' };
}


async function claimGiftCode(userId, code) {
  const url = `${API_BASE}/gift-codes/claim`;
  const payload = { userId, code };

  if (DRY_RUN) {
    log(`DRY_RUN=1 → SKIP gift code claim userId=${userId}, code="${code}"`);
    return { ok: true, dryRun: true };
  }

  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;

    try {
      const res = await axios.post(url, payload, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          origin: 'https://aithereumnetwork.com',
          referer: 'https://aithereumnetwork.com/',
          'user-agent': UA,
        },
        timeout: 30000,
        validateStatus: () => true,
      });

      if (res.status === 429) {
        const sleep = 1000 + Math.floor(Math.random() * 2000);
        log(
          `⚠️ [${userId}] 429 Too Many Requests for gift code="${code}", attempt ${attempts}/${maxAttempts}, sleeping ${sleep}ms...`
        );
        await wait(sleep);
        continue;
      }

      const body = (res.data && typeof res.data === 'object') ? res.data : {};
      const reward = body.reward ?? '?';
      const newBalance = body.newBalance ?? '?';
      const message = typeof body.message === 'string' ? body.message : '';

      if (res.status >= 200 && res.status < 300) {
        log(
          `✅ [${userId}] Gift code claimed: code="${code}", status=${res.status}, reward=${reward}, newBalance=${newBalance}, message="${message}"`
        );
        return { ok: true, status: res.status, data: body };
      } else {
        log(
          `❌ [${userId}] Gift code failed: code="${code}", status=${res.status}, message="${message}"`
        );
        return { ok: false, status: res.status, data: body };
      }
    } catch (err) {
      if (err.response && err.response.status === 429) {
        const sleep = 1000 + Math.floor(Math.random() * 2000);
        log(
          `⚠️ [${userId}] 429 error while claiming gift code="${code}", attempt ${attempts}/${maxAttempts}, sleeping ${sleep}ms...`
        );
          await wait(sleep);
          continue;
      }

      if (err.response) {
        log(
          `❌ [${userId}] Gift code error response: code="${code}", status=${err.response.status}`
        );
        return { ok: false, status: err.response.status, error: err.message };
      }
      log(
        `❌ [${userId}] Gift code network/unknown error: code="${code}", error=${err.message}`
      );
      return { ok: false, status: 0, error: err.message };
    }
  }

  log(
    `❌ [${userId}] Gift code claim aborted after ${maxAttempts} attempts (429 Too Many Requests) for code="${code}"`
  );
  return { ok: false, status: 429, error: 'Too many retries (429)' };
}

// check if a specific gift code already claimed
function hasClaimedGiftCode(userInfo, code) {
  if (!userInfo || !Array.isArray(userInfo.claimedGiftCodes)) return false;

  return userInfo.claimedGiftCodes.some((entry) => {
    if (!entry) return false;
    if (typeof entry === 'string') return entry === code;
    if (typeof entry === 'object' && 'code' in entry) return entry.code === code;
    return false;
  });
}

/* ---------------- Per-user processing ---------------- */

async function processUser(userId, activeTasks) {
  log(`\n===== User ${userId} =====`);

  // Fetch user info at the beginning (for gift-code check)
  const userInfoBefore = await fetchUser(userId);

  const userTasks = await fetchUserTasks(userId);

  const completedByType = new Map();
  for (const t of userTasks) {
    if (!completedByType.has(t.taskType)) completedByType.set(t.taskType, []);
    completedByType.get(t.taskType).push(t);
  }

  const today = new Date();

  // Daily check-in
  const dailyArr = completedByType.get('daily_checkin') || [];
  let alreadyDailyToday = false;
  if (dailyArr.length > 0) {
    const latest = dailyArr.reduce((a, b) =>
      new Date(a.completedAt) > new Date(b.completedAt) ? a : b
    );
    if (isSameUtcDate(latest.completedAt, today)) {
      alreadyDailyToday = true;
    }
  }

  if (alreadyDailyToday) {
    log(`[${userId}] Daily Check-in already claimed today → SKIP.`);
  } else {
    log(`[${userId}] Daily Check-in not claimed today → trying to claim...`);
    await claimTask(userId, 'daily_checkin', 'Daily Check-in');
  }

  // Other tasks
  for (const t of activeTasks) {
    const taskType = t.taskType;
    const taskName = t.title || t.taskName || t.description || taskType;

    if (taskType === 'daily_checkin') continue;

    if (completedByType.has(taskType)) {
      log(
        `[${userId}] Task ${taskType} ("${taskName}") already completed (count=${completedByType.get(taskType).length}) → SKIP.`
      );
      continue;
    }

    log(
      `[${userId}] Task ${taskType} ("${taskName}") not completed yet → trying to claim...`
    );
    await claimTask(userId, taskType, taskName);
  }

  // Gift codes (if any)
  if (GIFT_CODES.length > 0) {
    for (const code of GIFT_CODES) {
      if (hasClaimedGiftCode(userInfoBefore, code)) {
        log(`[${userId}] Gift code "${code}" already claimed → SKIP.`);
      } else {
        log(`[${userId}] Gift code "${code}" not claimed yet → trying to claim...`);
        await claimGiftCode(userId, code);
      }
    }
  }

  // Summary after all claims
  const userInfoAfter = await fetchUser(userId);
  if (userInfoAfter) {
    const completedCount = Array.isArray(userInfoAfter.completedTasks)
      ? userInfoAfter.completedTasks.length
      : 0;
    log(
      `[${userId}] SUMMARY: name="${userInfoAfter.name}", afdTokens=${userInfoAfter.afdTokens}, completedTasks=${completedCount}`
    );
  }
}

/* ---------------- One full run ---------------- */

async function runOnce() {
  log('Starting one full Aithereum run...');
  log(`USERS_FILE=${USERS_FILE}`);
  log(`DRY_RUN=${DRY_RUN ? '1 (TEST MODE)' : '0 (REAL)'}`);
  log(
    `GIFT_CODES=${GIFT_CODES.length > 0 ? GIFT_CODES.join(', ') : '(none, CODE env not set or empty)'}`
  );

  const activeTasks = await fetchActiveTasks();

  const hasDailyInActive = activeTasks.some((t) => t.taskType === 'daily_checkin');
  if (!hasDailyInActive) {
    activeTasks.unshift({
      _id: 'manual-daily',
      title: 'Daily Check-in',
      description: 'Daily check-in reward',
      taskType: 'daily_checkin',
      reward: 5,
      platform: 'Internal',
      isActive: true,
    });
  }

  let userIds;
  try {
    userIds = readUserIds(USERS_FILE);
  } catch (e) {
    console.error('[aithereum] Error reading user file:', e.message);
    return;
  }

  if (userIds.length === 0) {
    console.error('[aithereum] No userId found in users file. Please fill it first.');
    return;
  }

  log(`Total accounts: ${userIds.length}`);

  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i];
    log(`\n===== Account #${i + 1}/${userIds.length} → ${userId} =====`);

    await processUser(userId, activeTasks);

    if (i < userIds.length - 1) {
      const jitter = Math.floor(Math.random() * JITTER_MS);
      const sleepMs = BASE_SLEEP_MS + jitter;
      log(`Cooldown before next account: ${sleepMs}ms`);
      await wait(sleepMs);
    }
  }

  log('One full run for all accounts completed ✅');
}

/* ---------------- 24/7 loop ---------------- */

async function mainLoop() {
  log('Aithereum Bot MODE: 24/7 LOOP');
  log(
    `LOOP_INTERVAL_MS=${LOOP_INTERVAL_MS}ms (~${(LOOP_INTERVAL_MS / 60000).toFixed(
      1
    )} minutes between runs)`
  );

  while (true) {
    const started = new Date();
    log(`\n===== RUN START ${started.toISOString()} =====`);
    try {
      await runOnce();
    } catch (err) {
      console.error('[aithereum] Fatal error inside runOnce:', err);
    }
    const ended = new Date();
    log(`===== RUN END ${ended.toISOString()} =====`);

    log(`Sleeping ${LOOP_INTERVAL_MS}ms before the next run...`);
    await wait(LOOP_INTERVAL_MS);
  }
}

mainLoop().catch((err) => {
  console.error('[aithereum] Fatal error in mainLoop:', err);
  process.exit(1);
});
