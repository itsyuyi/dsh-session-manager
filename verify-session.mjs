#!/usr/bin/env node
/**
 * verify-session.mjs — 核对某个会话是否已从系统目录中真正删除。
 *
 * 用法：
 *   node verify-session.mjs                 # 列出所有已知会话及各自在磁盘上的存在情况
 *   node verify-session.mjs <id或标题片段>   # 核对匹配的会话，给出"是否已删除"的结论
 *
 * 检查的位置（删除会话时，插件会清理 1 和 2）：
 *   1) 会话工件目录   ~/.dsh/sessions/<项目>/session-<id>/     ← 主数据（rm -rf）
 *   2) 工作区登记     ~/.dsh/storages/workspace.json           ← 从 sessionIds/归档/置顶摘除
 *   3) 投影缓存       session_projcache.json + session_projcache/sessions/<id>.json
 *                     ← 派生缓存，删除后可能残留孤儿（无害，不会再被读取）
 *   （搜索索引 SQLite 会在下次搜索时自动 reconcile，无需手动核对）
 *
 * 判定"已删除"只看 1 和 2（权威来源）；投影缓存仅供参考。
 * 重要：当 <参数> 既不是任何已知 id、也匹配不到任何标题时，脚本报"未找到"，
 * 绝不据此推断"已删除"（避免假阴性）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT || join(DSH_HOME, 'sessions');
const WORKSPACE_JSON = join(DSH_HOME, 'storages', 'workspace.json');
const PROJCACHE_JSON = join(DSH_HOME, 'storages', 'session_projcache.json');
const PROJCACHE_DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

/** 与 JSONL 后端一致的段编码（对 UUID 形态的 id 是恒等）。 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 扫描会话工件根目录，返回该 id 对应的现存目录（通常 0 或 1 个）。 */
function findArtifactDirs(id) {
  const names = new Set([id, encodeSegment(id)]);
  const found = [];
  if (!existsSync(SESSIONS_ROOT)) return found;
  for (const proj of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pdir = join(SESSIONS_ROOT, proj.name);
    let entries;
    try {
      entries = readdirSync(pdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && names.has(e.name)) found.push(join(pdir, e.name));
    }
  }
  return found;
}

/** 逐会话投影缓存文件的 id 列表（session-*.json）。 */
function perSessionCacheIds() {
  if (!existsSync(PROJCACHE_DIR)) return [];
  return readdirSync(PROJCACHE_DIR)
    .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
}

/**
 * 标题 → id 映射。合并两处来源：
 *   - 聚合缓存 session_projcache.json:  tables.sessions.<id>.rows.title.val
 *   - 逐会话缓存 sessions/<id>.json:     record.rows.title.val（通常更新、覆盖新会话）
 */
function loadTitles() {
  const map = new Map();
  const agg = readJson(PROJCACHE_JSON);
  for (const [id, entry] of Object.entries(agg?.tables?.sessions || {})) {
    const t = entry?.rows?.title?.val;
    if (typeof t === 'string' && t) map.set(id, t);
  }
  if (existsSync(PROJCACHE_DIR)) {
    for (const f of readdirSync(PROJCACHE_DIR)) {
      if (!f.startsWith('session-') || !f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      const e = readJson(join(PROJCACHE_DIR, f));
      const t = e?.record?.rows?.title?.val;
      if (typeof t === 'string' && t) map.set(id, t); // 逐会话较新，覆盖聚合值
    }
  }
  return map;
}

/** 该 id 在 workspace.json 里还被哪些地方引用。 */
function workspaceRefs(id) {
  const w = readJson(WORKSPACE_JSON);
  if (!w) return [];
  const g = w.global || {};
  const refs = [];
  if ((g.archivedSessionIds || []).includes(id)) refs.push('归档集');
  if ((g.pinnedSessionIds || []).includes(id)) refs.push('置顶集');
  for (const [wid, ws] of Object.entries(w.tables?.workspaces || {})) {
    if ((ws.sessionIds || []).includes(id)) refs.push(`工作区「${ws.title || wid}」`);
  }
  return refs;
}

/** 投影缓存中是否仍有该 id（聚合表 或 逐会话文件），仅供参照。 */
function inProjcache(id) {
  const agg = readJson(PROJCACHE_JSON);
  if ((agg?.tables?.sessions || {})[id]) return true;
  return existsSync(join(PROJCACHE_DIR, `${id}.json`));
}

/** 收集所有出现过的会话 id（工件目录 ∪ workspace.json ∪ 两处投影缓存）。 */
function allSessionIds() {
  const ids = new Set();
  if (existsSync(SESSIONS_ROOT)) {
    for (const proj of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      let entries;
      try {
        entries = readdirSync(join(SESSIONS_ROOT, proj.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) if (e.isDirectory() && e.name.startsWith('session-')) ids.add(e.name);
    }
  }
  const w = readJson(WORKSPACE_JSON);
  for (const id of w?.global?.archivedSessionIds || []) ids.add(id);
  for (const id of w?.global?.pinnedSessionIds || []) ids.add(id);
  for (const ws of Object.values(w?.tables?.workspaces || {}))
    for (const id of ws.sessionIds || []) ids.add(id);
  for (const id of Object.keys(readJson(PROJCACHE_JSON)?.tables?.sessions || {})) ids.add(id);
  for (const id of perSessionCacheIds()) ids.add(id);
  return [...ids];
}

function statusOf(id) {
  const dirs = findArtifactDirs(id);
  const wrefs = workspaceRefs(id);
  const proj = inProjcache(id);
  // "已删除" = 工件目录不存在 且 workspace.json 无任何引用（投影缓存孤儿不算数）
  const deleted = dirs.length === 0 && wrefs.length === 0;
  return { dirs, wrefs, proj, deleted };
}

function reportOne(id, titles) {
  const s = statusOf(id);
  console.log(`\n会话：${id}`);
  if (titles.get(id)) console.log(`标题：${titles.get(id)}`);
  console.log(`  1) 工件目录  ~/.dsh/sessions/…/${id}/ : ${s.dirs.length ? '❌ 仍存在 → ' + s.dirs.join(', ') : '✅ 不存在'}`);
  console.log(`  2) 工作区登记 workspace.json          : ${s.wrefs.length ? '❌ 仍被引用 → ' + s.wrefs.join('、') : '✅ 无引用'}`);
  console.log(`  3) 投影缓存   session_projcache(.json|/sessions/) : ${s.proj ? '⚠️ 仍有缓存条目（派生数据，无害，不影响删除结论）' : '✅ 无'}`);
  console.log(`  结论：${s.deleted ? '✅ 已从系统目录中删除（主数据与登记均已清除）' : '⛔ 仍然存在，尚未删除（见上）'}`);
}

const arg = process.argv[2];
const titles = loadTitles();

if (!arg) {
  const ids = allSessionIds().sort();
  console.log(`共 ${ids.length} 个会话（标题取自投影缓存，新会话可能暂缺）：\n`);
  console.log('状态  会话id                                      工件  登记  缓存  标题');
  for (const id of ids) {
    const s = statusOf(id);
    const flag = s.deleted ? '已删' : '存在';
    console.log(
      `${flag}  ${id.padEnd(44)}  ${s.dirs.length ? '有' : '— '}    ${s.wrefs.length ? '有' : '— '}    ${s.proj ? '有' : '— '}   ${titles.get(id) || ''}`,
    );
  }
  console.log('\n提示：node verify-session.mjs <id或标题片段> 可核对单个会话。');
} else {
  const ids = allSessionIds();
  // 1) 先按 id 精确/子串匹配
  let matches = ids.filter((id) => id === arg || id.includes(arg));
  // 2) 再按标题片段匹配（合并两处缓存的标题）
  if (matches.length === 0) {
    matches = [...titles.entries()].filter(([, t]) => t.includes(arg)).map(([id]) => id);
  }
  matches = [...new Set(matches)];

  if (matches.length === 0) {
    // 关键：匹配不到 ≠ 已删除。明确报"未找到"，绝不给出删除结论。
    console.log(`\n⚠️ 未找到与「${arg}」匹配的会话。`);
    console.log('   它既不是任何已知会话 id，也没有任何会话的标题包含这段文字。');
    console.log('   可能原因：会话名不完全一致、标题投影尚未落盘，或该会话本就不存在。');
    console.log('   ⛔ 这不代表"已删除"。请改用：');
    console.log('      · node verify-session.mjs            # 看完整列表与标题，找到确切 id');
    console.log('      · node verify-session.mjs <完整id>    # 用 id 精确核对');
    process.exit(0);
  }

  for (const id of matches) reportOne(id, titles);
  if (matches.length > 1) console.log(`\n（匹配到 ${matches.length} 个会话）`);
}
