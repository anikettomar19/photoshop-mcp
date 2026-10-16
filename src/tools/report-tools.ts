import { arch, platform, release } from 'os';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { readRecentErrors, redactPaths, errorLogPath, errorLogEnabled } from '../core/error-log.js';
import { jsxEnum } from '../utils/jsx.js';
import { requireString } from '../utils/args.js';

export const REPO_URL = 'https://github.com/anikettomar19/photoshop-mcp';
const KINDS = ['BUG', 'TOOL_REQUEST'] as const;
type Kind = (typeof KINDS)[number];

// GitHub rejects very long URLs; past this the draft text is the full report
// and the link carries a shortened copy.
const MAX_URL_CHARS = 7000;

export function createReportTools(
  connection: PhotoshopConnection,
  serverVersion: string
): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_draft_issue',
        description:
          'Offline: only builds text. Makes no network request and submits nothing. Drafts a ' +
          'GitHub issue for this MCP server: a bug in a tool, or a tool that is missing (e.g. you ' +
          'had to fall back to photoshop_execute_script for something common). Fills in versions ' +
          'and, for bugs, the recent failed calls from the local error log, with home folders ' +
          'replaced by "~". Returns the draft and a link that opens a pre-filled GitHub form. Show ' +
          'the draft to the user, mention anything private it may still contain (file or layer ' +
          'names), and let them open the link and submit. Never submit for them without being asked.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: [...KINDS],
              description: 'BUG (a tool misbehaves) or TOOL_REQUEST (a tool is missing)',
            },
            title: { type: 'string', description: 'Short issue title' },
            tool: {
              type: 'string',
              description: 'Tool involved, e.g. photoshop_export_layer_as_png (optional)',
            },
            what_happened: {
              type: 'string',
              description: 'BUG: what happened. TOOL_REQUEST: what you needed to do',
            },
            expected: {
              type: 'string',
              description: 'BUG: what should have happened. TOOL_REQUEST: the tool you would want',
            },
            steps: {
              type: 'string',
              description: 'BUG: steps or the call that fails. TOOL_REQUEST: the workaround used',
            },
            include_recent_errors: {
              type: 'number',
              description: 'How many recent failed calls to attach (default 3, 0 for none)',
            },
          },
          required: ['kind', 'title', 'what_happened'],
        },
      },
      handler: async (args) => draftIssue(connection, serverVersion, args),
    },
  ];
}

export interface IssueDraft {
  kind: Kind;
  title: string;
  fields: Record<string, string>;
  template: string;
  labels: string;
}

/** Builds the form fields; every value goes through redactPaths. */
export function buildIssueDraft(
  args: Record<string, unknown>,
  environment: string,
  recentErrors: string
): IssueDraft {
  const kind = jsxEnum(String(args.kind ?? '').toUpperCase(), KINDS, 'kind');
  const title = redactPaths(requireString(args, 'title'));
  const text = (k: string) => (typeof args[k] === 'string' ? redactPaths(String(args[k])) : '');
  const tool = text('tool');
  if (kind === 'BUG') {
    return {
      kind,
      title,
      template: 'bug_report.yml',
      labels: 'bug',
      fields: {
        tool,
        'what-happened': text('what_happened'),
        expected: text('expected'),
        steps: text('steps'),
        'error-output': recentErrors,
        environment,
      },
    };
  }
  return {
    kind,
    title,
    template: 'tool_request.yml',
    labels: 'enhancement',
    fields: {
      need: text('what_happened'),
      'proposed-tool': text('expected'),
      workaround: [text('steps'), tool ? `Related tool: ${tool}` : ''].filter(Boolean).join('\n'),
      environment,
    },
  };
}

/** Pre-filled issue-form URL; long fields are shortened to keep it under the limit. */
export function issueUrl(draft: IssueDraft): { url: string; shortened: boolean } {
  const build = (fields: Record<string, string>) => {
    const q = new URLSearchParams({
      template: draft.template,
      title: draft.title,
      labels: draft.labels,
    });
    for (const [k, v] of Object.entries(fields)) if (v) q.set(k, v);
    return `${REPO_URL}/issues/new?${q.toString()}`;
  };
  let fields = { ...draft.fields };
  let url = build(fields);
  if (url.length <= MAX_URL_CHARS) return { url, shortened: false };
  for (
    let budget = 1500;
    budget >= 100 && url.length > MAX_URL_CHARS;
    budget = Math.floor(budget / 2)
  ) {
    fields = Object.fromEntries(
      Object.entries(draft.fields).map(([k, v]) => [
        k,
        v.length > budget ? `${v.slice(0, budget)}\n… (shortened; see the full draft)` : v,
      ])
    );
    url = build(fields);
  }
  return { url, shortened: true };
}

export function draftMarkdown(draft: IssueDraft): string {
  const headings: Record<string, string> = {
    tool: 'Tool',
    'what-happened': 'What happened',
    expected: 'Expected',
    steps: 'Steps / failing call',
    'error-output': 'Recent errors',
    environment: 'Environment',
    need: 'What I needed to do',
    'proposed-tool': 'Proposed tool',
    workaround: 'Workaround used',
  };
  const parts = [`# ${draft.title}`, `_${draft.kind === 'BUG' ? 'Bug report' : 'Tool request'}_`];
  for (const [k, v] of Object.entries(draft.fields)) {
    if (v) parts.push(`## ${headings[k] ?? k}\n${v}`);
  }
  return parts.join('\n\n');
}

async function photoshopVersion(connection: PhotoshopConnection): Promise<string> {
  try {
    const v = await Promise.race([
      connection.getVersion(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return String(v);
  } catch {
    return 'unknown (Photoshop not reachable)';
  }
}

async function draftIssue(
  connection: PhotoshopConnection,
  serverVersion: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const kind = jsxEnum(String(args.kind ?? '').toUpperCase(), KINDS, 'kind');
    const environment = [
      `photoshop-mcp: ${serverVersion}`,
      `Photoshop: ${await photoshopVersion(connection)}`,
      `OS: ${platform()} ${release()} (${arch()})`,
      `Node: ${process.version}`,
    ].join('\n');
    const n = typeof args.include_recent_errors === 'number' ? args.include_recent_errors : 3;
    const tool = typeof args.tool === 'string' && args.tool ? args.tool : undefined;
    const errors = kind === 'BUG' && n > 0 ? readRecentErrors(n, tool) : [];
    const recent = errors
      .map((e) => `${e.time} ${e.tool}\nargs: ${JSON.stringify(e.args)}\nerror: ${e.error}`)
      .join('\n\n');

    const draft = buildIssueDraft(args, environment, recent);
    const { url, shortened } = issueUrl(draft);
    const notes = [
      'Nothing has been submitted. Show this draft to the user; they open the link, review and submit.',
      'Home folders were replaced by "~". File, layer and document names are kept — check them before submitting.',
      kind === 'BUG' && n > 0
        ? errors.length
          ? `Attached ${errors.length} recent failed call(s) from ${redactPaths(errorLogPath())}.`
          : errorLogEnabled()
            ? 'No recent failed calls were logged for this tool.'
            : 'The local error log is off (PHOTOSHOP_MCP_ERROR_LOG), so no failed calls were attached.'
        : '',
      shortened
        ? 'The link carries a shortened copy; paste the full draft into the issue if needed.'
        : '',
    ].filter(Boolean);

    return {
      content: [
        {
          type: 'text' as const,
          text: `${notes.join('\n')}\n\nOpen to file it: ${url}\n\n---\n${draftMarkdown(draft)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
