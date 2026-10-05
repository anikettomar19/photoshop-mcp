import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { jsxString } from '../utils/jsx.js';
import { ToolDefinition } from './tool-registry.js';

/**
 * Gives every live-Photoshop tool an optional `document` argument.
 *
 * Tools act on app.activeDocument, so with several PSDs open a caller had to
 * switch documents first. In real sessions 82 hand-written execute_script
 * calls did that (app.documents.getByName(...)), and a click in Photoshop
 * between calls could still change which document the next tool hit. With
 * `document` set, that document is activated in the same tool call.
 */
export const DOCUMENT_ARG = 'document';

// Tools where a target document makes no sense, or that already take one
// under their own name.
const SKIP = new Set([
  'photoshop_ping',
  'photoshop_get_version',
  'photoshop_get_session_info',
  'photoshop_create_document',
  'photoshop_open_image',
  'photoshop_set_active_document',
  'photoshop_batch_export_layers', // document_name
  'photoshop_prep_ui_for_unity', // documentName
  'photoshop_swap_mockup_asset', // documentName
]);

export function activateDocumentScript(name: string): string {
  return `
    var want = ${jsxString(name)};
    var names = [];
    for (var i = 0; i < app.documents.length; i++) {
      if (app.documents[i].name === want) {
        app.activeDocument = app.documents[i];
        return want;
      }
      names.push('"' + app.documents[i].name + '"');
    }
    throw new Error('Document ' + want + ' is not open. Open documents: ' + (names.length ? names.join(', ') : '(none)'));
  `;
}

export function withDocumentTarget(
  def: ToolDefinition,
  connection: PhotoshopConnection
): ToolDefinition {
  if (SKIP.has(def.tool.name)) return def;
  const properties = (def.tool.inputSchema.properties ?? {}) as Record<string, unknown>;
  if (DOCUMENT_ARG in properties) return def;

  return {
    tool: {
      ...def.tool,
      inputSchema: {
        ...def.tool.inputSchema,
        properties: {
          ...properties,
          [DOCUMENT_ARG]: {
            type: 'string',
            description:
              'Optional name of an open document (e.g. "Main Screen.psd") to act on. ' +
              'It is made the active document first. Omit to use the active document.',
          },
        },
      },
    },
    handler: async (args) => {
      const { [DOCUMENT_ARG]: document, ...rest } = args;
      if (typeof document === 'string' && document !== '') {
        const api = await new PhotoshopAPIFactory(connection).createAPI();
        await api.executeScript(activateDocumentScript(document));
      }
      return def.handler(rest);
    },
  };
}
