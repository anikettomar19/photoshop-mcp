// execute_script returns the value of the script's last statement. The
// generated body is plain ES3-compatible JavaScript, so it can be run here as
// the server's wrapper runs it: inside a function. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtendScriptSnippets } from '../dist/api/extendscript.js';

const run = (code) => new Function(ExtendScriptSnippets.executeCustomScript(code))();

test('the last statement is the result even when it shares a line', () => {
  assert.equal(run('var x = 1; x'), 1);
  assert.deepEqual(run('var res = {a: 1}; res'), { a: 1 });
  assert.equal(run("var r = 'ok'; try { r = 'fine'; } catch (e) {} r"), 'fine');
  assert.equal(run("var o = [1, 2]; o.push(3); o.join(',')"), '1,2,3');
  assert.equal(run("var log = []; log.push('closed'); 'ok'"), 'ok', 'not the value of the first call');
});

test('multi-line scripts, function declarations and loops', () => {
  assert.deepEqual(run('var r = {a: 1};\nr'), { a: 1 });
  assert.equal(run('function f() { return 42; }\nf()'), 42);
  assert.equal(run('var s = 0; for (var i = 0; i < 4; i++) s += i; s'), 6);
});

test('scripts written with a top-level return still work, and run once', () => {
  assert.equal(run('var a = 5;\nreturn a * 2;'), 10);
  assert.equal(run("var n = 3;\nif (n > 2) { return 'big'; }\nreturn 'small';"), 'big');
  globalThis.__runs = 0;
  run('globalThis.__runs++;\nreturn globalThis.__runs;');
  assert.equal(globalThis.__runs, 1);
});

test('a bare object literal is an object, a block is a block', () => {
  assert.deepEqual(run("{a: 1, b: 'x'}"), { a: 1, b: 'x' });
  assert.equal(run('{ var q = 7; q }'), 7);
});

test('errors still surface', () => {
  assert.throws(() => run('var a = ;'), SyntaxError);
  assert.throws(() => run("throw new Error('boom')"), /boom/);
  assert.throws(() => run('return = 1'), SyntaxError, 'a syntax error with "return" in it is not hidden');
});

test('the source is embedded as a string, not spliced', () => {
  const nasty = 'var s = "a\\"b\'c\\\\d e"; s';
  assert.equal(run(nasty), 'a"b\'c\\d e');
});
