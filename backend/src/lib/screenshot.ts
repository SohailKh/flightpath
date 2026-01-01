/**
 * Screenshot Capture Module
 *
 * Provides screenshot capture using Playwright for web-based testing.
 * Shares browser management with playwright-tools.ts for efficiency.
 */

import { chromium, type Browser } from "playwright";
import { getBrowser as getSharedBrowser, closeBrowser as closeSharedBrowser } from "./playwright-tools";

// Configuration
const DEFAULT_TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 720 };

// Fallback browser for standalone usage
let fallbackBrowserInstance: Browser | null = null;

/**
 * Get browser instance
 * Tries to use shared browser from playwright-tools first,
 * falls back to standalone instance if needed
 */
async function getBrowser(): Promise<Browser> {
  try {
    // Try to use shared browser from playwright-tools
    return await getSharedBrowser();
  } catch {
    // Fallback to standalone browser
    if (!fallbackBrowserInstance || !fallbackBrowserInstance.isConnected()) {
      fallbackBrowserInstance = await chromium.launch({
        headless: true,
      });
    }
    return fallbackBrowserInstance;
  }
}

/**
 * Close the browser instance
 * Call this when done capturing screenshots to free resources
 */
export async function closeBrowser(): Promise<void> {
  // Close shared browser
  await closeSharedBrowser();

  // Close fallback browser if it exists
  if (fallbackBrowserInstance) {
    await fallbackBrowserInstance.close();
    fallbackBrowserInstance = null;
  }
}

export interface CaptureOptions {
  /** Wait until network is idle before capturing */
  waitForNetworkIdle?: boolean;
  /** Custom timeout in ms */
  timeout?: number;
  /** Capture full page or just viewport */
  fullPage?: boolean;
  /** Custom viewport size */
  viewport?: { width: number; height: number };
  /** Wait for a specific selector before capturing */
  waitForSelector?: string;
}

/**
 * Capture a screenshot of a web page
 *
 * @param url - The URL to capture
 * @param options - Capture options
 * @returns PNG image data as Buffer
 */
export async function captureWebScreenshot(
  url: string,
  options: CaptureOptions = {}
): Promise<Buffer> {
  const {
    waitForNetworkIdle = true,
    timeout = DEFAULT_TIMEOUT_MS,
    fullPage = true,
    viewport = VIEWPORT,
    waitForSelector,
  } = options;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport,
  });

  const page = await context.newPage();

  try {
    // Navigate to the URL
    await page.goto(url, {
      waitUntil: waitForNetworkIdle ? "networkidle" : "load",
      timeout,
    });

    // Wait for specific element if requested
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout });
    }

    // Capture screenshot
    const screenshot = await page.screenshot({
      fullPage,
      type: "png",
    });

    return Buffer.from(screenshot);
  } finally {
    await context.close();
  }
}

/**
 * Capture multiple screenshots from a list of URLs
 *
 * @param urls - Array of URLs to capture
 * @param options - Capture options
 * @returns Array of { url, screenshot, error } results
 */
export async function captureMultipleScreenshots(
  urls: string[],
  options: CaptureOptions = {}
): Promise<Array<{ url: string; screenshot?: Buffer; error?: string }>> {
  const results: Array<{ url: string; screenshot?: Buffer; error?: string }> =
    [];

  for (const url of urls) {
    try {
      const screenshot = await captureWebScreenshot(url, options);
      results.push({ url, screenshot });
    } catch (err) {
      results.push({
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Check if a URL is accessible
 *
 * @param url - The URL to check
 * @param timeout - Timeout in ms
 * @returns true if accessible, false otherwise
 */
export async function isUrlAccessible(
  url: string,
  timeout = 5000
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      method: "HEAD",
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}
