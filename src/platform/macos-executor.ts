import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '../utils/logger.js';
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  ScriptExecutor,
  SerialQueue,
  parseScriptOutput,
  timeoutError,
} from './script-executor.js';

const execFileAsync = promisify(execFile);

/** Quotes a value for an AppleScript string literal. */
function appleScriptString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export class MacOSExecutor implements ScriptExecutor {
  private logger: Logger;
  private queue = new SerialQueue();
  private appName: string = 'Adobe Photoshop 2025';

  constructor() {
    this.logger = new Logger('MacOSExecutor');
  }

  setAppName(appName: string): void {
    this.appName = appName;
    this.logger.debug(`App name set to: ${appName}`);
  }

  async execute(script: string, timeout: number = DEFAULT_SCRIPT_TIMEOUT_MS): Promise<unknown> {
    return this.queue.run(() => this.executeScript(script, timeout));
  }

  private async executeScript(script: string, timeout: number): Promise<unknown> {
    // For macOS, we'll use AppleScript to execute JavaScript in Photoshop
    const id = randomUUID();
    const tempScriptPath = join(tmpdir(), `photoshop-script-${id}.jsx`);
    const tempAppleScriptPath = join(tmpdir(), `photoshop-applescript-${id}.scpt`);

    try {
      await writeFile(tempScriptPath, script, 'utf8');

      // Create AppleScript that tells Photoshop to execute the JSX
      const appleScript = this.createAppleScriptWrapper(tempScriptPath, timeout);
      await writeFile(tempAppleScriptPath, appleScript, 'utf8');

      let stdout: string;
      try {
        // Killing osascript is the only way to stop waiting: Photoshop itself
        // cannot be interrupted and will finish the script regardless.
        ({ stdout } = await execFileAsync('osascript', [tempAppleScriptPath], {
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024 * 1024,
        }));
      } catch (error) {
        const e = error as { killed?: boolean; signal?: string; stderr?: string; message?: string };
        if (e.killed || e.signal === 'SIGKILL') {
          throw timeoutError(timeout);
        }
        this.logger.error('AppleScript execution failed:', error);
        throw new Error(e.stderr?.trim() || e.message || String(error));
      } finally {
        await unlink(tempAppleScriptPath).catch(() => {});
      }

      return parseScriptOutput(stdout);
    } finally {
      await unlink(tempScriptPath).catch(() => {});
    }
  }

  private createAppleScriptWrapper(jsxPath: string, timeout: number): string {
    // Use POSIX file path for AppleScript
    const posixPath = jsxPath.replace(/\\/g, '/');
    // Apple events give up after 120s by default, which would cut long scripts
    // short regardless of our own timeout; give AppleScript a little headroom
    // so ours is the one that fires.
    const seconds = Math.ceil(timeout / 1000) + 10;

    return `with timeout of ${seconds} seconds
\ttell application ${appleScriptString(this.appName)}
\t\tdo javascript "$.evalFile('${posixPath}')"
\tend tell
end timeout`;
  }

  async isPhotoshopRunning(): Promise<boolean> {
    // Ask AppleScript about this exact app rather than pgrep: "Adobe Photoshop"
    // also matches helper and crash-reporter processes. "is running" does not
    // launch the app.
    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        `application ${appleScriptString(this.appName)} is running`,
      ]);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async launchPhotoshop(photoshopPath: string): Promise<void> {
    this.logger.info(`Launching Photoshop: ${photoshopPath}`);

    // Use 'open' command on macOS to launch the app. The caller waits for
    // Photoshop to answer scripts; 'open' returns as soon as launch starts.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('open', ['-a', photoshopPath], { stdio: 'ignore' });
      child.on('error', (error) => reject(new Error(`Failed to launch Photoshop: ${error.message}`)));
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Failed to launch Photoshop: open exited with ${code}`))
      );
    });
  }
}
