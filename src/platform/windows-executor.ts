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

export class WindowsExecutor implements ScriptExecutor {
  private logger: Logger;
  private queue = new SerialQueue();

  constructor() {
    this.logger = new Logger('WindowsExecutor');
  }

  async execute(script: string, timeout: number = DEFAULT_SCRIPT_TIMEOUT_MS): Promise<unknown> {
    return this.queue.run(() => this.executeScript(script, timeout));
  }

  private async executeScript(script: string, timeout: number): Promise<unknown> {
    // For Windows, we'll use a combination of VBScript/JScript to communicate with Photoshop via COM
    // Write script to temporary file
    const id = randomUUID();
    const tempScriptPath = join(tmpdir(), `photoshop-script-${id}.jsx`);
    const vbsPath = join(tmpdir(), `photoshop-vbs-${id}.vbs`);

    try {
      await writeFile(tempScriptPath, script, 'utf8');

      // Use VBScript to execute the JSX script via COM
      await writeFile(vbsPath, this.createVBSWrapper(tempScriptPath), 'utf8');

      let stdout: string;
      try {
        // Killing cscript is the only way to stop waiting: Photoshop itself
        // cannot be interrupted and will finish the script regardless.
        ({ stdout } = await execFileAsync('cscript', ['//nologo', vbsPath], {
          timeout,
          maxBuffer: 64 * 1024 * 1024,
        }));
      } catch (error) {
        const e = error as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
        if (e.killed) {
          throw timeoutError(timeout);
        }
        // The VBS wrapper reports failures on stdout with a non-zero exit.
        if (e.stdout?.trim().startsWith('ERROR:')) {
          return parseScriptOutput(e.stdout);
        }
        throw new Error(e.stderr?.trim() || e.message || String(error));
      } finally {
        // Cleanup VBS file
        await unlink(vbsPath).catch(() => {});
      }

      return parseScriptOutput(stdout);
    } finally {
      // Cleanup JSX file
      await unlink(tempScriptPath).catch(() => {});
    }
  }

  private createVBSWrapper(jsxPath: string): string {
    return `
On Error Resume Next
Dim photoshopApp
Set photoshopApp = CreateObject("Photoshop.Application")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: Failed to connect to Photoshop - " & Err.Description
    WScript.Quit 1
End If

' Execute the JSX script
Dim result
result = photoshopApp.DoJavaScript("$.evalFile('" & Replace("${jsxPath}", "\\", "\\\\") & "');")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: " & Err.Description
    WScript.Quit 1
Else
    WScript.Echo result
End If
`.trim();
  }

  async isPhotoshopRunning(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq Photoshop.exe']);
      return stdout.toLowerCase().includes('photoshop.exe');
    } catch {
      return false;
    }
  }

  async launchPhotoshop(photoshopPath: string): Promise<void> {
    this.logger.info(`Launching Photoshop: ${photoshopPath}`);

    // The caller waits for Photoshop to answer scripts; this only starts it.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(photoshopPath, [], { detached: true, stdio: 'ignore' });
      child.on('error', (error) => reject(new Error(`Failed to launch Photoshop: ${error.message}`)));
      child.on('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}
