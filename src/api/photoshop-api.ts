import { Logger } from '../utils/logger.js';
import { PhotoshopConnection } from '../platform/connection.js';

export type APIType = 'UXP' | 'ExtendScript';

export interface PhotoshopAPI {
  /**
   * Execute a script using the appropriate API
   * @param timeout - Milliseconds to allow once the script starts. Defaults to
   *   DEFAULT_SCRIPT_TIMEOUT_MS; pass LONG_SCRIPT_TIMEOUT_MS for whole-document
   *   walks and multi-layer exports.
   */
  executeScript(script: string, timeout?: number): Promise<unknown>;

  /**
   * Get the API type being used
   */
  getAPIType(): APIType;
}

export class PhotoshopAPIFactory {
  private logger: Logger;
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.logger = new Logger('PhotoshopAPIFactory');
    this.connection = connection;
  }

  async createAPI(): Promise<PhotoshopAPI> {
    const info = this.connection.getPhotoshopInfo();

    if (!info) {
      throw new Error('Photoshop info not available. Please detect Photoshop first.');
    }

    // Determine which API to use based on version
    const apiType = this.determineAPIType(info.version);

    this.logger.info(`Creating ${apiType} API for Photoshop version ${info.version}`);

    if (apiType === 'UXP') {
      return new UXPPhotoshopAPI(this.connection);
    } else {
      return new ExtendScriptPhotoshopAPI(this.connection);
    }
  }

  private determineAPIType(version: string): APIType {
    // IMPORTANT: When running scripts via AppleScript/COM, we can only use ExtendScript
    // UXP is only available for plugins, not for external script execution
    // Therefore, we always use ExtendScript for external automation

    this.logger.debug(
      `Using ExtendScript for version ${version} (UXP not available for external scripting)`
    );
    return 'ExtendScript';
  }
}

/**
 * UXP-based API for modern Photoshop (23.5+)
 * NOTE: UXP is not available for external script execution via AppleScript/COM
 * This class is kept for future plugin-based implementation
 */
class UXPPhotoshopAPI implements PhotoshopAPI {
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.connection = connection;
  }

  async executeScript(script: string, timeout?: number): Promise<unknown> {
    // UXP cannot be executed externally via AppleScript/COM
    // Fall back to ExtendScript
    return await this.connection.executeScript(script, timeout);
  }

  getAPIType(): APIType {
    return 'UXP';
  }
}

/**
 * ExtendScript-based API for legacy Photoshop (< 23.5)
 */
class ExtendScriptPhotoshopAPI implements PhotoshopAPI {
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.connection = connection;
  }

  async executeScript(script: string, timeout?: number): Promise<unknown> {
    // Wrap script in error handling
    const wrappedScript = this.wrapInErrorHandling(script);
    return await this.connection.executeScript(wrappedScript, timeout);
  }

  private wrapInErrorHandling(script: string): string {
    // ExtendScript doesn't have JSON object, we return plain result
    // The result will be converted to string by Photoshop
    //
    // Dialogs are turned off for the duration of the script: with them on, an
    // error (e.g. sampling outside the canvas) opens a modal alert that blocks
    // every later script until someone clicks it, so one bad call turned into a
    // run of timeouts. With them off the same error is thrown and reported.
    // The user's own setting is restored afterwards.
    return `
(function() {
  var __prevDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;
  try {
    var result = (function() {
      ${script}
    })();
    // Convert result to string for transport
    if (typeof result === 'object' && result !== null) {
      return result.toSource ? result.toSource() : String(result);
    }
    return String(result);
  } catch (error) {
    return 'ERROR: ' + (error.message || String(error));
  } finally {
    app.displayDialogs = __prevDialogs;
  }
})();
    `.trim();
  }

  getAPIType(): APIType {
    return 'ExtendScript';
  }
}
