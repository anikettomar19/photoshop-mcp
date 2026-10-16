// Issue drafting and the local error log. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { buildIssueDraft, issueUrl, draftMarkdown, REPO_URL } from '../dist/tools/report-tools.js';
import {
  recordToolError,
  readRecentErrors,
  redactPaths,
  sanitizeArgs,
} from '../dist/core/error-log.js';

const home = homedir();

test('paths are redacted to ~, including other users\u2019 home folders', () => {
  assert.equal(redactPaths(`${home}/Documents/ui.psd`), '~/Documents/ui.psd');
  assert.equal(redactPaths('/Users/someone/x.png'), '~/x.png');
  assert.equal(redactPaths('C:\\Users\\someone\\x.png'), '~\\x.png');
});

test('logged args are redacted and capped', () => {
  const a = sanitizeArgs({ path: `${home}/a.psd`, code: 'x'.repeat(5000), n: 3, list: [1, 2] });
  assert.equal(a.path, '~/a.psd');
  assert.ok(String(a.code).length < 1600);
  assert.equal(a.n, 3);
  assert.equal(a.list, '[1,2]');
});

test('the error log records, filters by tool, and can be turned off', () => {
  process.env.PHOTOSHOP_MCP_HOME = mkdtempSync(join(tmpdir(), 'psmcp-'));
  recordToolError('photoshop_a', { p: `${home}/x` }, `Error at ${home}/y`, '9.9.9');
  recordToolError('photoshop_b', {}, 'b failed', '9.9.9');
  assert.equal(readRecentErrors(10).length, 2);
  const onlyA = readRecentErrors(10, 'a');
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].error, 'Error at ~/y');
  assert.ok(
    !readFileSync(join(process.env.PHOTOSHOP_MCP_HOME, 'errors.jsonl'), 'utf8').includes(home)
  );
  process.env.PHOTOSHOP_MCP_ERROR_LOG = 'off';
  recordToolError('photoshop_c', {}, 'c', '9.9.9');
  assert.equal(readRecentErrors(10).length, 2);
  delete process.env.PHOTOSHOP_MCP_ERROR_LOG;
});

test('a bug draft fills the bug form fields and the URL points at the form', () => {
  const d = buildIssueDraft(
    {
      kind: 'bug',
      title: `Broken in ${home}/p.psd`,
      tool: 'photoshop_x',
      what_happened: 'it failed',
    },
    'env',
    'recent'
  );
  assert.equal(d.template, 'bug_report.yml');
  assert.equal(d.title, 'Broken in ~/p.psd');
  const { url, shortened } = issueUrl(d);
  assert.ok(url.startsWith(`${REPO_URL}/issues/new?`));
  const q = new URL(url).searchParams;
  assert.equal(q.get('template'), 'bug_report.yml');
  assert.equal(q.get('what-happened'), 'it failed');
  assert.equal(q.get('error-output'), 'recent');
  assert.equal(shortened, false);
  assert.match(draftMarkdown(d), /## What happened\nit failed/);
});

test('a tool request uses the tool-request form', () => {
  const d = buildIssueDraft(
    {
      kind: 'TOOL_REQUEST',
      title: 't',
      what_happened: 'need',
      expected: 'tool',
      steps: 'script',
      tool: 'photoshop_execute_script',
    },
    'env',
    ''
  );
  const q = new URL(issueUrl(d).url).searchParams;
  assert.equal(q.get('template'), 'tool_request.yml');
  assert.equal(q.get('need'), 'need');
  assert.match(q.get('workaround'), /script\nRelated tool: photoshop_execute_script/);
});

test('long reports keep the URL under the limit and say so', () => {
  const d = buildIssueDraft(
    { kind: 'BUG', title: 't', what_happened: 'x'.repeat(20000) },
    'env',
    'y'.repeat(9000)
  );
  const { url, shortened } = issueUrl(d);
  assert.ok(url.length <= 7000, `url is ${url.length}`);
  assert.equal(shortened, true);
});

test('the form field ids match what the tool fills', () => {
  const ids = (file) =>
    [
      ...readFileSync(
        new URL(`../.github/ISSUE_TEMPLATE/${file}`, import.meta.url),
        'utf8'
      ).matchAll(/^\s+id: (\S+)/gm),
    ].map((m) => m[1]);
  const bug = buildIssueDraft({ kind: 'BUG', title: 't', what_happened: 'w' }, 'e', 'r');
  assert.deepEqual(Object.keys(bug.fields).sort(), ids('bug_report.yml').sort());
  const req = buildIssueDraft({ kind: 'TOOL_REQUEST', title: 't', what_happened: 'w' }, 'e', '');
  assert.deepEqual(Object.keys(req.fields).sort(), ids('tool_request.yml').sort());
});
