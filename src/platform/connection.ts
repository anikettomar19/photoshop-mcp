import { platform } from 'os';
import { Logger } from '../utils/logger.js';
import { PhotoshopDetector } from './detector.js';
import { ScriptExecutor } from './script-executor.js';
import { WindowsExecutor } from './windows-executor.js';
import { MacOSExecutor } from './macos-executor.js';

export interface PhotoshopInfo {
  version: string;
  path: string;
  isRunning: boolean;
  appName?: string;
}

export class PhotoshopConnection {
  private logger: Logger;
  private detector: PhotoshopDetector;
  private executor: ScriptExecutor;
  private photoshopInfo: PhotoshopInfo | null = null;
  private macosExecutor?: MacOSExecutor;

  constructor() {
    this.logger = new Logger('PhotoshopConnection');
    this.detector = new PhotoshopDetector();

    // Initialize platform-specific executor
    const platformType = platform();
    if (platformType === 'win32') {
      this.executor = new WindowsExecutor();
    } else if (platformType === 'darwin') {
      this.macosExecutor = new MacOSExecutor();
      this.executor = this.macosExecutor;
    } else {
      throw new Error(`Unsupported platform: ${platformType}`);
    }
  }

  async ping(): Promise<boolean> {
    try {
      this.logger.debug('Pinging Photoshop...');

      // Try to detect Photoshop if not already detected
      if (!this.photoshopInfo) {
        this.photoshopInfo = await this.detector.detect();
      }

      // For now, just check if Photoshop is detected
      return this.photoshopInfo !== null;
    } catch (error) {
      this.logger.error('Ping failed:', error);
      return false;
    }
  }

  async getVersion(): Promise<string> {
    try {
      if (!this.photoshopInfo) {
        this.photoshopInfo = await this.detector.detect();
      }

      return this.photoshopInfo?.version || 'Unknown';
    } catch (error) {
      this.logger.error('Failed to get version:', error);
      throw error;
    }
  }

  async executeScript(script: string, timeout?: number): Promise<unknown> {
    try {
      await this.ensurePhotoshopRunning();

      // Execute the script
      return await this.executor.execute(script, timeout);
    } catch (error) {
      this.logger.error('Script execution failed:', error);
      throw error;
    }
  }

  getPhotoshopInfo(): PhotoshopInfo | null {
    return this.photoshopInfo;
  }

  async ensurePhotoshopRunning(): Promise<void> {
    // Ensure Photoshop is detected
    if (!this.photoshopInfo) {
      this.photoshopInfo = await this.detector.detect();
    }

    // Set app name for macOS executor
    if (this.macosExecutor && this.photoshopInfo.appName) {
      this.macosExecutor.setAppName(this.photoshopInfo.appName);
    }

    if (await this.executor.isPhotoshopRunning()) {
      return;
    }

    this.logger.info('Photoshop not running, launching...');
    await this.executor.launchPhotoshop(this.photoshopInfo.path);
    await this.waitUntilReady();
  }

  /**
   * A cold start takes far longer than the process appearing, and scripts sent
   * before Photoshop finishes loading fail. Poll with a trivial script until it
   * answers.
   */
  private async waitUntilReady(maxWaitMs = 180_000, intervalMs = 2_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.executor.execute('app.name;', 10_000);
        this.logger.info('Photoshop is ready');
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    throw new Error(
      `Photoshop did not become ready within ${maxWaitMs / 1000}s: ` +
        (lastError instanceof Error ? lastError.message : String(lastError))
    );
  }
}
