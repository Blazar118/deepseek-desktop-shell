'use strict';

/**
 * Local tools the agent can call.
 *
 * Everything is confined to a workspace root that the user picks. Paths are
 * resolved and re-checked after resolution, so `..` and absolute paths outside
 * the root are rejected rather than silently followed.
 *
 * Every tool returns { ok: true, ... } or { ok: false, error }. Tools never
 * throw at the model: a failed read is information, not a crash.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const MAX_READ_BYTES = 200 * 1024;
const MAX_OUTPUT_CHARS = 30000;
const DEFAULT_TIMEOUT_MS = 60000;

/* ------------------------------------------------------------------ */
/* path safety                                                         */
/* ------------------------------------------------------------------ */

function resolveInside(root, target) {
  const raw = String(target ?? '.');
  const rootAbs = path.resolve(root);

  // Reject absolute input up front instead of relying on path.resolve to fold it
  // in. On Windows an absolute path can also arrive as a foreign drive or a UNC
  // share, and a backslash path handed to a POSIX build would otherwise look
  // like a harmless relative name.
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.startsWith('\\\\')) {
    return { ok: false, error: 'path-outside-workspace', detail: raw };
  }

  const full = path.resolve(rootAbs, raw);
  const rel = path.relative(rootAbs, full);
  if (rel.startsWith('..') || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) {
    return { ok: false, error: 'path-outside-workspace', detail: full };
  }
  return { ok: true, path: full, rel: rel === '' ? '.' : rel };
}

/* ------------------------------------------------------------------ */
/* tool implementations                                                */
/* ------------------------------------------------------------------ */

async function listDir(args, ctx) {
  const r = resolveInside(ctx.root, args.path);
  if (!r.ok) return r;
  const entries = await fsp.readdir(r.path, { withFileTypes: true });
  const items = entries
    .slice(0, 500)
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { ok: true, path: r.rel, count: items.length, items };
}

async function readFile(args, ctx) {
  const r = resolveInside(ctx.root, args.path);
  if (!r.ok) return r;
  const stat = await fsp.stat(r.path);
  if (stat.isDirectory()) return { ok: false, error: 'is-a-directory' };
  const size = stat.size;
  if (size > MAX_READ_BYTES) {
    const fd = await fsp.open(r.path, 'r');
    try {
      const buf = Buffer.alloc(MAX_READ_BYTES);
      const { bytesRead } = await fd.read(buf, 0, MAX_READ_BYTES, 0);
      return {
        ok: true,
        path: r.rel,
        truncated: true,
        size,
        content: buf.subarray(0, bytesRead).toString('utf8'),
      };
    } finally {
      await fd.close();
    }
  }
  const content = await fsp.readFile(r.path, 'utf8');
  return { ok: true, path: r.rel, truncated: false, size, content };
}

async function writeFile(args, ctx) {
  const r = resolveInside(ctx.root, args.path);
  if (!r.ok) return r;
  await fsp.mkdir(path.dirname(r.path), { recursive: true });
  const content = String(args.content ?? '');
  await fsp.writeFile(r.path, content, 'utf8');
  return { ok: true, path: r.rel, bytes: Buffer.byteLength(content, 'utf8') };
}

async function appendFile(args, ctx) {
  const r = resolveInside(ctx.root, args.path);
  if (!r.ok) return r;
  await fsp.mkdir(path.dirname(r.path), { recursive: true });
  await fsp.appendFile(r.path, String(args.content ?? ''), 'utf8');
  return { ok: true, path: r.rel };
}

async function makeDir(args, ctx) {
  const r = resolveInside(ctx.root, args.path);
  if (!r.ok) return r;
  await fsp.mkdir(r.path, { recursive: true });
  return { ok: true, path: r.rel };
}

async function deletePath(args, ctx) {
  const r = resolveInside(ctx.root, args.path);
  if (!r.ok) return r;
  if (r.rel === '.') return { ok: false, error: 'refusing-to-delete-workspace-root' };
  await fsp.rm(r.path, { recursive: Boolean(args.recursive), force: true });
  return { ok: true, path: r.rel };
}

async function searchFiles(args, ctx) {
  const r = resolveInside(ctx.root, args.path);
  if (!r.ok) return r;
  const needle = String(args.query || '');
  if (!needle) return { ok: false, error: 'empty-query' };

  const maxHits = Math.min(Number(args.maxHits) || 60, 200);
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', '.npm-cache', '.tmp', 'build']);
  const hits = [];

  const walk = async (dir) => {
    if (hits.length >= maxHits) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= maxHits) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name)) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (stat.size > MAX_READ_BYTES) continue;
      let text;
      try { text = await fsp.readFile(full, 'utf8'); } catch { continue; }
      if (!text.includes(needle)) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
        if (lines[i].includes(needle)) {
          hits.push({
            path: path.relative(path.resolve(ctx.root), full),
            line: i + 1,
            text: lines[i].trim().slice(0, 240),
          });
        }
      }
    }
  };

  await walk(r.path);
  return { ok: true, query: needle, hits, truncated: hits.length >= maxHits };
}

function runCommand(args, ctx) {
  const command = String(args.command || '').trim();
  if (!command) return Promise.resolve({ ok: false, error: 'empty-command' });

  // Commands run through PowerShell so quoting behaves the same as in the app's
  // own logs. This is the one tool that can do anything to the machine, which is
  // why the caller gates it behind an explicit approval prompt.
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const timeout = Math.min(Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS, 300000);

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { cwd: ctx.root, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const clip = (s) => (s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]' : s);
        resolve({
          ok: !err,
          exitCode: err && typeof err.code === 'number' ? err.code : 0,
          stdout: clip(String(stdout || '')),
          stderr: clip(String(stderr || '')),
          timedOut: Boolean(err && err.killed),
        });
      }
    );
  });
}

/* ------------------------------------------------------------------ */
/* registry                                                           */
/* ------------------------------------------------------------------ */

// `dangerous: true` tools never run without the user saying yes.
const TOOLS = {
  list_dir: {
    args: '{ "path": "relative/dir" }',
    does: 'List a directory inside the workspace.',
    run: listDir,
  },
  read_file: {
    args: '{ "path": "relative/file.txt" }',
    does: 'Read a text file (first 200 KB if larger).',
    run: readFile,
  },
  write_file: {
    args: '{ "path": "relative/file.txt", "content": "..." }',
    does: 'Create or overwrite a text file.',
    run: writeFile,
  },
  append_file: {
    args: '{ "path": "relative/file.txt", "content": "..." }',
    does: 'Append text to a file, creating it if needed.',
    run: appendFile,
  },
  make_dir: {
    args: '{ "path": "relative/dir" }',
    does: 'Create a directory (including parents).',
    run: makeDir,
  },
  search_files: {
    args: '{ "query": "text", "path": ".", "maxHits": 60 }',
    does: 'Search file contents under the workspace for a literal string.',
    run: searchFiles,
  },
  delete_path: {
    args: '{ "path": "relative/item", "recursive": false }',
    does: 'Delete a file or directory. Requires user approval.',
    dangerous: true,
    run: deletePath,
  },
  run_command: {
    args: '{ "command": "Get-ChildItem", "timeoutMs": 60000 }',
    does: 'Run a PowerShell command in the workspace. Requires user approval.',
    dangerous: true,
    run: runCommand,
  },
};

function toolCatalogue() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    args: t.args,
    does: t.does,
    dangerous: Boolean(t.dangerous),
  }));
}

async function callTool(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: 'unknown-tool', detail: name };
  try {
    return await tool.run(args || {}, ctx);
  } catch (err) {
    return { ok: false, error: 'tool-threw', detail: err && err.message ? err.message : String(err) };
  }
}

function isDangerous(name) {
  return Boolean(TOOLS[name] && TOOLS[name].dangerous);
}

module.exports = { toolCatalogue, callTool, isDangerous, resolveInside, TOOLS };
