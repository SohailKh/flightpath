/**
 * Dev Server Manager
 *
 * Manages lifecycle of development servers for testing:
 * - Start servers before tests
 * - Health check polling with timeout
 * - Cleanup after tests complete
 */

import { spawn, type ChildProcess } from "node:child_process";
import { loadProjectConfig, type PlatformConfig } from "./project-config";

// Configuration
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 60_000; // 60 seconds
const HEALTH_CHECK_POLL_INTERVAL_MS = 2_000; // 2 seconds
const SERVER_STARTUP_DELAY_MS = 1_000; // 1 second after spawn

export interface ServerHandle {
  platform: string;
  process: ChildProcess;
  pid: number | undefined;
  healthCheckUrl: string | undefined;
  healthy: boolean;
}

export interface StartServersOptions {
  projectPath: string;
  timeoutMs?: number;
  onLog?: (platform: string, message: string) => void;
  onHealthy?: (platform: string) => void;
  onError?: (platform: string, error: string) => void;
}

export interface StartServersResult {
  servers: ServerHandle[];
  allHealthy: boolean;
  errors: Array<{ platform: string; error: string }>;
}

/**
 * Check if a URL is reachable and returns 2xx status
 */
async function checkHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      method: "GET",
    });

    clearTimeout(timeoutId);
    return response.ok; // 200-299
  } catch {
    return false;
  }
}

/**
 * Poll health check URL until healthy or timeout
 */
async function waitForHealthy(
  url: string,
  timeoutMs: number,
  pollIntervalMs: number = HEALTH_CHECK_POLL_INTERVAL_MS
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await checkHealth(url)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return false;
}

/**
 * Start a dev server for a platform
 */
function startServerProcess(
  platform: string,
  config: PlatformConfig,
  projectPath: string,
  onLog?: (platform: string, message: string) => void
): ChildProcess | null {
  if (!config.devCommand) {
    return null;
  }

  const cwd = `${projectPath}/${config.directory}`;

  // Parse the command - handle npm/bun/pnpm commands
  const [cmd, ...args] = config.devCommand.split(" ");

  onLog?.(platform, `Starting: ${config.devCommand} in ${cwd}`);

  const child = spawn(cmd, args, {
    cwd,
    shell: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Disable interactive prompts
      CI: "true",
      // Force color output
      FORCE_COLOR: "1",
    },
  });

  // Log stdout/stderr
  child.stdout?.on("data", (data) => {
    onLog?.(platform, `[stdout] ${data.toString().trim()}`);
  });

  child.stderr?.on("data", (data) => {
    onLog?.(platform, `[stderr] ${data.toString().trim()}`);
  });

  child.on("error", (err) => {
    onLog?.(platform, `[error] ${err.message}`);
  });

  return child;
}

/**
 * Start dev servers for all enabled platforms
 */
export async function startDevServers(
  options: StartServersOptions
): Promise<StartServersResult> {
  const {
    projectPath,
    timeoutMs = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
    onLog,
    onHealthy,
    onError,
  } = options;

  const config = await loadProjectConfig(projectPath);
  const servers: ServerHandle[] = [];
  const errors: Array<{ platform: string; error: string }> = [];

  // Get enabled platforms with devCommand
  const enabledPlatforms = Object.entries(config.platforms).filter(
    ([_, p]) => p.enabled && p.devCommand
  );

  if (enabledPlatforms.length === 0) {
    console.log(`[DevServer] No platforms with devCommand configured`);
    onLog?.("system", "No platforms with devCommand configured");
    return { servers, allHealthy: true, errors };
  }

  console.log(`[DevServer] Starting ${enabledPlatforms.length} dev server(s)`);

  // Start all servers
  for (const [platformName, platformConfig] of enabledPlatforms) {
    console.log(`[DevServer] Starting ${platformName} server...`);
    const process = startServerProcess(
      platformName,
      platformConfig,
      projectPath,
      onLog
    );

    if (!process) {
      const error = `No devCommand for platform ${platformName}`;
      errors.push({ platform: platformName, error });
      onError?.(platformName, error);
      continue;
    }

    servers.push({
      platform: platformName,
      process,
      pid: process.pid,
      healthCheckUrl: platformConfig.healthCheckUrl,
      healthy: false,
    });
  }

  // Wait for initial startup
  await new Promise((resolve) => setTimeout(resolve, SERVER_STARTUP_DELAY_MS));

  // Health check each server
  const healthCheckPromises = servers.map(async (server) => {
    if (!server.healthCheckUrl) {
      // No health check URL - assume healthy after startup delay
      onLog?.(server.platform, "No healthCheckUrl, assuming healthy");
      server.healthy = true;
      onHealthy?.(server.platform);
      return;
    }

    onLog?.(server.platform, `Waiting for health: ${server.healthCheckUrl}`);

    const isHealthy = await waitForHealthy(server.healthCheckUrl, timeoutMs);

    server.healthy = isHealthy;

    if (isHealthy) {
      console.log(`[DevServer] ${server.platform} ready at ${server.healthCheckUrl}`);
      onLog?.(server.platform, "Server is healthy");
      onHealthy?.(server.platform);
    } else {
      console.log(`[DevServer] ${server.platform} health check: FAILED (timeout after ${timeoutMs}ms)`);
      const error = `Health check timeout after ${timeoutMs}ms`;
      errors.push({ platform: server.platform, error });
      onError?.(server.platform, error);
    }
  });

  await Promise.all(healthCheckPromises);

  const allHealthy = servers.every((s) => s.healthy);
  console.log(`[DevServer] All servers started. Healthy: ${servers.filter(s => s.healthy).length}/${servers.length}`);

  return { servers, allHealthy, errors };
}

/**
 * Stop all dev servers
 */
export async function stopDevServers(
  servers: ServerHandle[],
  onLog?: (platform: string, message: string) => void
): Promise<void> {
  console.log(`[DevServer] Stopping ${servers.length} server(s)`);

  for (const server of servers) {
    if (server.process && !server.process.killed) {
      console.log(`[DevServer] Stopping ${server.platform} server`);
      onLog?.(server.platform, `Stopping server (PID: ${server.pid})`);

      try {
        // Try graceful shutdown first (SIGTERM)
        server.process.kill("SIGTERM");

        // Wait a bit for graceful shutdown
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Force kill if still running
        if (!server.process.killed) {
          server.process.kill("SIGKILL");
          console.log(`[DevServer] ${server.platform} force killed`);
          onLog?.(server.platform, "Force killed server");
        } else {
          console.log(`[DevServer] ${server.platform} stopped gracefully`);
          onLog?.(server.platform, "Server stopped gracefully");
        }
      } catch (err) {
        console.log(`[DevServer] ${server.platform} error stopping: ${err}`);
        onLog?.(server.platform, `Error stopping server: ${err}`);
      }
    }
  }
}

/**
 * Check if any server is still running
 */
export function hasRunningServers(servers: ServerHandle[]): boolean {
  return servers.some((s) => s.process && !s.process.killed);
}
