// The README's tool table must match the tools the server registers: every
// tool listed once, nothing that doesn't exist, and each category's count
// right. Starts the built server over stdio; no Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

function registeredTools() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('server did not answer tools/list'));
    }, 20000);
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        try {
          const m = JSON.parse(line);
          if (m.id === 2) {
            clearTimeout(timer);
            p.kill();
            resolve(m.result.tools.map((t) => t.name));
          }
        } catch {}
      }
    });
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'readme-test', version: '1' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

function readmeTable() {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const rows = md.split('\n').filter((l) => /^\| \*\*[^*]+\*\* \(\d+\) \|/.test(l));
  return rows.map((row) => {
    const [, label, count] = row.match(/^\| \*\*([^*]+)\*\* \((\d+)\) \|/);
    const cell = row.split('|')[2];
    const names = [];
    let stem = '';
    for (const [, tok] of cell.matchAll(/`([^`]+)`/g)) {
      // "move_layer_up / _down / _to_top": a leading "_" continues the stem of
      // the last full name ("move_layer").
      if (tok.startsWith('_') && stem) {
        names.push(stem + tok);
      } else {
        names.push(tok);
        stem = tok.slice(0, tok.lastIndexOf('_'));
      }
    }
    return { label, count: Number(count), names };
  });
}

test('every registered tool is in the README table exactly once, and nothing else is', async () => {
  const registered = (await registeredTools()).map((n) => n.replace(/^photoshop_/, '')).sort();
  const listed = readmeTable()
    .flatMap((r) => r.names)
    .sort();
  const dupes = listed.filter((n, i) => listed[i - 1] === n);
  assert.deepEqual(dupes, [], 'listed more than once');
  assert.deepEqual(
    registered.filter((n) => !listed.includes(n)),
    [],
    'registered but missing from the README'
  );
  assert.deepEqual(
    listed.filter((n) => !registered.includes(n)),
    [],
    'in the README but not registered'
  );
});

test('each README category count matches the tools it lists', () => {
  for (const r of readmeTable())
    assert.equal(r.count, r.names.length, `"${r.label}" says ${r.count}, lists ${r.names.length}`);
});
