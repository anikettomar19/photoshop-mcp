import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialQueue, parseScriptOutput, timeoutError } from '../dist/platform/script-executor.js';

test('script errors from the ExtendScript wrapper become thrown errors', () => {
  assert.throws(() => parseScriptOutput('ERROR: Layer not found at path segment: "x"\n'), {
    message: 'Layer not found at path segment: "x"',
  });
});

test('ordinary output is parsed as JSON when possible, else returned as text', () => {
  assert.deepEqual(parseScriptOutput('{"a":1}\n'), { a: 1 });
  assert.equal(parseScriptOutput('({name:"x"})'), '({name:"x"})');
  assert.equal(parseScriptOutput('out.png|OK|done|1'), 'out.png|OK|done|1');
});

test('SerialQueue runs one task at a time, in order, past failures', async () => {
  const queue = new SerialQueue();
  const log = [];
  let running = 0;
  const task =
    (name, ms, fail = false) =>
    async () => {
      running++;
      assert.equal(running, 1, 'tasks overlapped');
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      running--;
      if (fail) throw new Error(name);
      return name;
    };

  const results = await Promise.allSettled([
    queue.run(task('a', 20, true)),
    queue.run(task('b', 5)),
    queue.run(task('c', 1)),
  ]);

  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].value, 'b');
  assert.equal(results[2].value, 'c');
});

test('timeoutError says how long it waited', () => {
  assert.match(timeoutError(45_000).message, /after 45s/);
});
