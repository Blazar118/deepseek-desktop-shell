'use strict';

// Unit checks for the parts of the agent that do not need a browser:
// tool-call parsing, path containment, and the tool implementations.
//
//   node scripts/test-agent-core.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseToolCall } = require('../src/agent');
const { callTool, resolveInside, toolCatalogue } = require('../src/tools');

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    console.error('  FAIL ' + name + '\n       ' + err.message);
    process.exitCode = 1;
  }
};

console.log('parseToolCall');
ok('clean tool block', () => {
  const r = parseToolCall('```tool\n{"tool":"read_file","args":{"path":"a.txt"}}\n```');
  assert.strictEqual(r.kind, 'call');
  assert.strictEqual(r.tool, 'read_file');
  assert.strictEqual(r.args.path, 'a.txt');
});

ok('fence without language tag', () => {
  const r = parseToolCall('```\n{"tool":"list_dir","args":{"path":"."}}\n```');
  assert.strictEqual(r.kind, 'call');
  assert.strictEqual(r.tool, 'list_dir');
});

ok('surrounded by prose', () => {
  const r = parseToolCall('我需要先看看目录。\n```tool\n{"tool":"list_dir","args":{}}\n```\n然后再继续。');
  assert.strictEqual(r.kind, 'call');
  assert.strictEqual(r.tool, 'list_dir');
});

ok('trailing comma tolerated', () => {
  const r = parseToolCall('```tool\n{"tool":"read_file","args":{"path":"a.txt",},}\n```');
  assert.strictEqual(r.kind, 'call');
});

ok('smart quotes tolerated', () => {
  const r = parseToolCall('```tool\n{\u201ctool\u201d:\u201cread_file\u201d,\u201cargs\u201d:{\u201cpath\u201d:\u201ca.txt\u201d}}\n```');
  assert.strictEqual(r.kind, 'call');
  assert.strictEqual(r.tool, 'read_file');
});

ok('plain answer is final', () => {
  const r = parseToolCall('都做完了，文件在 notes.md。');
  assert.strictEqual(r.kind, 'final');
  assert.strictEqual(r.text, '都做完了，文件在 notes.md。');
});

ok('bare json object with tool key', () => {
  const r = parseToolCall('{"tool":"list_dir","args":{"path":"."}}');
  assert.strictEqual(r.kind, 'call');
});

ok('block without tool name falls back to final', () => {
  const r = parseToolCall('```json\n{"foo":"bar"}\n```');
  assert.strictEqual(r.kind, 'final');
});

console.log('path containment');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsagent-'));
fs.writeFileSync(path.join(root, 'hello.txt'), 'hello world\nsecond line\n');
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'needle here\n');

ok('relative path inside root', () => {
  const r = resolveInside(root, 'hello.txt');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rel, 'hello.txt');
});

ok('dot resolves to root', () => {
  const r = resolveInside(root, '.');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rel, '.');
});

ok('parent escape rejected', () => {
  const r = resolveInside(root, '../outside.txt');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'path-outside-workspace');
});

ok('absolute escape rejected', () => {
  // Built from the real platform root so the test is meaningful on any OS.
  const r = resolveInside(root, path.join(path.parse(root).root, 'Windows', 'System32', 'drivers', 'etc', 'hosts'));
  assert.strictEqual(r.ok, false);
});

ok('foreign-platform absolute path rejected', () => {
  // A Windows path handed to a POSIX build must not be treated as a relative name.
  const r = resolveInside(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts');
  assert.strictEqual(r.ok, false);
  const r2 = resolveInside(root, '\\\\server\\share\\file.txt');
  assert.strictEqual(r2.ok, false);
});

ok('nested escape rejected', () => {
  const r = resolveInside(root, 'sub/../../outside.txt');
  assert.strictEqual(r.ok, false);
});

console.log('tools');
const run = (name, args) => callTool(name, args, { root });

(async () => {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      pass++;
      console.log('  ok   ' + name);
    } catch (err) {
      console.error('  FAIL ' + name + '\n       ' + err.message);
      process.exitCode = 1;
    }
  };

  await check('list_dir', async () => {
    const r = await run('list_dir', { path: '.' });
    assert.strictEqual(r.ok, true);
    const names = r.items.map((i) => i.name);
    assert.ok(names.includes('hello.txt'), 'expected hello.txt in ' + names.join(','));
    assert.ok(names.includes('sub'));
  });

  await check('read_file', async () => {
    const r = await run('read_file', { path: 'hello.txt' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.content, 'hello world\nsecond line\n');
    assert.strictEqual(r.truncated, false);
  });

  await check('read_file outside root refused', async () => {
    const r = await run('read_file', { path: '../secret.txt' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'path-outside-workspace');
  });

  await check('write_file + read back', async () => {
    const w = await run('write_file', { path: 'out/note.md', content: '# hi\n' });
    assert.strictEqual(w.ok, true);
    const r = await run('read_file', { path: 'out/note.md' });
    assert.strictEqual(r.content, '# hi\n');
  });

  await check('append_file', async () => {
    await run('append_file', { path: 'out/note.md', content: 'more\n' });
    const r = await run('read_file', { path: 'out/note.md' });
    assert.strictEqual(r.content, '# hi\nmore\n');
  });

  await check('search_files', async () => {
    const r = await run('search_files', { query: 'needle', path: '.' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.hits.length, 1);
    assert.ok(r.hits[0].path.endsWith('inner.txt'));
    assert.strictEqual(r.hits[0].line, 1);
  });

  await check('delete_path refuses root', async () => {
    const r = await run('delete_path', { path: '.', recursive: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'refusing-to-delete-workspace-root');
  });

  await check('delete_path removes a file', async () => {
    const r = await run('delete_path', { path: 'out/note.md' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fs.existsSync(path.join(root, 'out', 'note.md')), false);
  });

  await check('unknown tool refused', async () => {
    const r = await run('rm_rf_everything', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'unknown-tool');
  });

  // run_command shells out to PowerShell, so these two only mean anything on
  // Windows. They are skipped rather than faked elsewhere: a POSIX machine
  // would need a different command interpreter entirely, and pretending the
  // PowerShell path works there would hide that.
  if (process.platform === 'win32') {
    await check('run_command executes in root', async () => {
      const r = await run('run_command', { command: 'Write-Output "agent-test-ok"' });
      assert.strictEqual(r.ok, true);
      assert.ok(r.stdout.includes('agent-test-ok'), 'stdout was: ' + r.stdout);
    });

    await check('run_command reports failure', async () => {
      const r = await run('run_command', { command: 'throw "boom"' });
      assert.strictEqual(r.ok, false);
      assert.ok((r.stderr || '').includes('boom'));
    });
  } else {
    console.log('  skip run_command executes in root (needs Windows PowerShell)');
    console.log('  skip run_command reports failure (needs Windows PowerShell)');
  }

  await check('catalogue marks dangerous tools', async () => {
    const cat = toolCatalogue();
    const byName = Object.fromEntries(cat.map((t) => [t.name, t]));
    assert.strictEqual(byName.run_command.dangerous, true);
    assert.strictEqual(byName.delete_path.dangerous, true);
    assert.strictEqual(byName.read_file.dangerous, false);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n' + pass + ' checks passed' + (process.exitCode ? ' (with failures)' : ''));
})();
