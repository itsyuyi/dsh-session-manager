/**
 * Host half of @itsyuyi/dsh-session-manager.
 *
 * Durable session deletion for workspace session management:
 *   1. refuse while the session is live in this host (an open Session or Agent),
 *   2. clean the workspace registry (unarchive, unpin, detach from every
 *      workspace account),
 *   3. remove the session's JSONL artifact directory from the persistence root.
 *
 * The SQLite search index reconciles itself: once `sessionPersistence.list()`
 * no longer observes the artifact, the next search drops the stale row, so no
 * index write is needed here. The projection cache is a derived, id-keyed
 * cache; an orphaned entry is never read again after the log is gone.
 */
import { readdir, rm, stat as fsStat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const ROUTE = '/plugins/dsh-session-manager/delete-session';
const MAX_BODY_BYTES = 64 * 1024;
/**
 * Accepted session ids: the runtime's `session-<uuid>` / `session-<n>` shape.
 * The hex-and-dash body rejects path separators and dots outright; artifact
 * removal is additionally traversal-proof because it only ever matches names
 * that already exist as directories under the persistence root.
 */
const SESSION_ID_PATTERN = /^session-[0-9a-fA-F-]{1,128}$/;

export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence'];

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => serveDeleteSession(ctx, req, res),
      }),
    'dsh-session-manager: delete-session route',
  );
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing (same shape the shipped plugin routes use)            */
/* ------------------------------------------------------------------ */

async function serveDeleteSession(ctx, req, res) {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed');
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
    return jsonError(res, 415, 'json-required');
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected');

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, 'invalid-request');
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!SESSION_ID_PATTERN.test(sessionId)) return jsonError(res, 400, 'invalid-session-id');

  try {
    const result = await deleteSession(ctx, sessionId);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result));
  } catch (error) {
    jsonError(res, 500, 'delete-failed', error instanceof Error ? error.message : String(error));
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin !== undefined && host !== undefined && origin !== `http://${host}` && origin !== `https://${host}`)
    return false;
  return true;
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error('request too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function jsonError(res, status, code, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(message === undefined ? { ok: false, error: code } : { ok: false, error: code, message }));
}

/* ------------------------------------------------------------------ */
/* Deletion                                                            */
/* ------------------------------------------------------------------ */

async function deleteSession(ctx, sessionId) {
  // 1. Refuse only sessions with ACTUAL running work — a turn in flight, an
  //    owned job, a live subagent, or an active schedule. This is exactly the
  //    host's archive-admission criterion (`workspace/session-activity`
  //    waterfall): an idle session that merely happens to be open/loaded stays
  //    deletable. The event bus is global, so dispatching from this plugin's
  //    context reaches the same turn/job/subagent/schedule listeners the
  //    registry asks; a non-empty result means "stop it first".
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
  const families = Array.isArray(activity) ? activity.map((a) => (a && a.kind) || 'unknown') : [];
  if (families.length > 0) return { ok: false, error: 'session-live', activity: families, guard: 'activity-v2' };

  // 2. Registry cleanup: clear the registry-global archive/pin sets, then
  //    detach from every workspace account that lists the session. All three
  //    are idempotent for unknown ids.
  let detached = 0;
  const registry = ctx.workspaceRegistry;
  if (registry) {
    try {
      await registry.unarchiveSession(sessionId);
    } catch {
      /* not archived / unknown — nothing to clear */
    }
    try {
      await registry.unpinSession(sessionId);
    } catch {
      /* not pinned / unknown — nothing to clear */
    }
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds?.includes(sessionId)) continue;
      await workspace.detachSession(sessionId);
      detached += 1;
    }
  }

  // 3. Artifact removal under the persistence root.
  const removed = await removeArtifacts(ctx, sessionId);

  return { ok: true, detached, removedArtifact: removed > 0, removedDirs: removed, guard: 'activity-v2' };
}

/**
 * Remove the session's artifact directory. The directory name under each
 * project directory is `encodeSegment(sessionId)`, which is the identity for
 * the runtime's `session-<hex>` ids; scanning the root's project directories
 * for that exact name keeps this independent of the header cwd encoding.
 * @returns the number of removed directories (0 or 1 in practice).
 */
async function removeArtifacts(ctx, sessionId) {
  const root = ctx.sessionPersistence?.config?.root;
  if (typeof root !== 'string' || root.length === 0) return 0;

  const names = new Set([sessionId, encodeSegment(sessionId)]);
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !names.has(entry.name)) continue;
      const target = resolve(join(projectPath, entry.name));
      // Containment guard: never escape the persistence root.
      if (!target.startsWith(resolve(root) + sep)) continue;
      await rm(target, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/** Exact copy of the JSONL backend's segment encoder (safe chars pass through). */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
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
