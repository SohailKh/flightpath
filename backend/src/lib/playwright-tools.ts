/**
 * Playwright Web Testing Tools
 *
 * Browser actions exposed as callable tools for agent consumption.
 * Provides intelligent element selection with fallback chain.
 */

import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { resolveElement, formatSelector } from "./playwright-selector";
import type {
  ElementSelector,
  PlaywrightActionResult,
  NavigationResult,
  TypeResult,
  AssertionResult,
  HttpRequestResult,
  BrowserOptions,
  NavigateOptions,
  ClickOptions,
  TypeOptions,
  ScreenshotOptions,
  HttpRequestOptions,
  PlaywrightToolDefinition,
  ResolveOptions,
} from "./playwright-types";

// Browser lifecycle state
let browserInstance: Browser | null = null;
let currentContext: BrowserContext | null = null;
let currentPage: Page | null = null;
let baseUrl: string | undefined;

// Default configuration
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_TIMEOUT = 30000;

/**
 * Initialize browser for testing session
 */
export async function initBrowser(options: BrowserOptions = {}): Promise<void> {
  const {
    headless = true,
    baseUrl: base,
    viewport = DEFAULT_VIEWPORT,
  } = options;

  baseUrl = base;

  if (browserInstance && browserInstance.isConnected()) {
    return; // Already initialized
  }

  browserInstance = await chromium.launch({ headless });
  currentContext = await browserInstance.newContext({ viewport });
  currentPage = await currentContext.newPage();
}

/**
 * Get current page, initializing browser if needed
 */
export async function getPage(): Promise<Page> {
  if (!currentPage || !browserInstance?.isConnected()) {
    await initBrowser();
  }
  return currentPage!;
}

/**
 * Get browser instance (for compatibility with screenshot.ts)
 */
export async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    await initBrowser();
  }
  return browserInstance!;
}

/**
 * Close browser and cleanup resources
 */
export async function closeBrowser(): Promise<void> {
  if (currentContext) {
    await currentContext.close();
    currentContext = null;
    currentPage = null;
  }
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Resolve URL with base URL if relative
 */
function resolveUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  if (baseUrl) {
    return baseUrl.replace(/\/$/, "") + (url.startsWith("/") ? url : "/" + url);
  }
  return url;
}

// ============================================================================
// CORE BROWSER ACTIONS
// ============================================================================

/**
 * Navigate to URL
 */
export async function navigate(
  url: string,
  options: NavigateOptions = {}
): Promise<NavigationResult> {
  const startTime = Date.now();
  const { waitUntil = "networkidle", timeout = DEFAULT_TIMEOUT } = options;

  try {
    const page = await getPage();
    const resolvedUrl = resolveUrl(url);

    const response = await page.goto(resolvedUrl, { waitUntil, timeout });
    const title = await page.title();

    return {
      success: true,
      action: "navigate",
      url: resolvedUrl,
      statusCode: response?.status(),
      title,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      action: "navigate",
      url,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Click an element
 */
export async function click(
  selector: ElementSelector,
  options: ClickOptions = {}
): Promise<PlaywrightActionResult> {
  const startTime = Date.now();
  const { clickCount = 1, button = "left", delay, ...resolveOpts } = options;

  try {
    const page = await getPage();
    const resolution = await resolveElement(page, selector, resolveOpts);

    if (!resolution.success) {
      return {
        success: false,
        action: "click",
        selector,
        resolution,
        duration: Date.now() - startTime,
        error: resolution.error,
      };
    }

    await resolution.element!.click({ clickCount, button, delay });

    // Capture post-click screenshot for evidence
    const screenshot = options.captureEvidence
      ? await page.screenshot()
      : undefined;

    return {
      success: true,
      action: "click",
      selector,
      resolution,
      screenshot,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      action: "click",
      selector,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Type text into an element (appends to existing text)
 */
export async function type(
  selector: ElementSelector,
  value: string,
  options: TypeOptions = {}
): Promise<TypeResult> {
  const startTime = Date.now();
  const { delay, clear = false, ...resolveOpts } = options;

  try {
    const page = await getPage();
    const resolution = await resolveElement(page, selector, resolveOpts);

    if (!resolution.success) {
      return {
        success: false,
        action: "type",
        selector,
        resolution,
        value,
        cleared: false,
        duration: Date.now() - startTime,
        error: resolution.error,
      };
    }

    if (clear) {
      await resolution.element!.fill("");
    }

    await resolution.element!.type(value, { delay });

    return {
      success: true,
      action: "type",
      selector,
      resolution,
      value,
      cleared: clear,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      action: "type",
      selector,
      value,
      cleared: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Clear and type (fill) - replaces existing text
 */
export async function fill(
  selector: ElementSelector,
  value: string,
  options: ResolveOptions = {}
): Promise<TypeResult> {
  const startTime = Date.now();

  try {
    const page = await getPage();
    const resolution = await resolveElement(page, selector, options);

    if (!resolution.success) {
      return {
        success: false,
        action: "fill",
        selector,
        resolution,
        value,
        cleared: true,
        duration: Date.now() - startTime,
        error: resolution.error,
      };
    }

    await resolution.element!.fill(value);

    return {
      success: true,
      action: "fill",
      selector,
      resolution,
      value,
      cleared: true,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      action: "fill",
      selector,
      value,
      cleared: true,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Take screenshot
 */
export async function screenshot(
  name?: string,
  options: ScreenshotOptions = {}
): Promise<Buffer> {
  const { fullPage = true } = options;
  const page = await getPage();
  return Buffer.from(await page.screenshot({ fullPage, type: "png" }));
}

/**
 * Wait for element to be visible
 */
export async function waitForSelector(
  selector: ElementSelector,
  options: ResolveOptions = {}
): Promise<PlaywrightActionResult> {
  const startTime = Date.now();

  try {
    const page = await getPage();
    const resolution = await resolveElement(page, selector, options);

    return {
      success: resolution.success,
      action: "waitForSelector",
      selector,
      resolution,
      duration: Date.now() - startTime,
      error: resolution.error,
    };
  } catch (error) {
    return {
      success: false,
      action: "waitForSelector",
      selector,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Assert element is visible
 */
export async function assertVisible(
  selector: ElementSelector,
  options: ResolveOptions = {}
): Promise<AssertionResult> {
  const startTime = Date.now();

  try {
    const page = await getPage();
    const resolution = await resolveElement(page, selector, options);

    const passed = resolution.success;

    // Capture screenshot for evidence
    const screenshotBuf = await page.screenshot();

    return {
      success: true, // Action succeeded (assertion may have failed)
      action: "assert",
      assertion: "visible",
      selector,
      resolution,
      expected: true,
      actual: passed,
      passed,
      screenshot: screenshotBuf,
      duration: Date.now() - startTime,
      error: passed ? undefined : `Element not visible: ${formatSelector(selector)}`,
    };
  } catch (error) {
    return {
      success: false,
      action: "assert",
      assertion: "visible",
      selector,
      expected: true,
      actual: false,
      passed: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Assert element contains text
 */
export async function assertText(
  selector: ElementSelector,
  expectedText: string,
  options: ResolveOptions = {}
): Promise<AssertionResult> {
  const startTime = Date.now();

  try {
    const page = await getPage();
    const resolution = await resolveElement(page, selector, options);

    if (!resolution.success) {
      return {
        success: false,
        action: "assert",
        assertion: "text",
        selector,
        resolution,
        expected: expectedText,
        actual: null,
        passed: false,
        duration: Date.now() - startTime,
        error: resolution.error,
      };
    }

    const actualText = await resolution.element!.textContent();
    const passed = actualText?.includes(expectedText) ?? false;

    return {
      success: true,
      action: "assert",
      assertion: "text",
      selector,
      resolution,
      expected: expectedText,
      actual: actualText,
      passed,
      duration: Date.now() - startTime,
      error: passed ? undefined : `Expected "${expectedText}" but got "${actualText}"`,
    };
  } catch (error) {
    return {
      success: false,
      action: "assert",
      assertion: "text",
      selector,
      expected: expectedText,
      actual: null,
      passed: false,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Wait for a duration
 */
export async function wait(ms: number): Promise<PlaywrightActionResult> {
  const startTime = Date.now();

  await new Promise((resolve) => setTimeout(resolve, ms));

  return {
    success: true,
    action: "wait",
    duration: Date.now() - startTime,
    metadata: { waitedMs: ms },
  };
}

/**
 * Make HTTP request (for API testing)
 */
export async function httpRequest(
  method: string,
  url: string,
  options: HttpRequestOptions = {}
): Promise<HttpRequestResult> {
  const startTime = Date.now();
  const { body, headers = {}, expectStatus, timeout = DEFAULT_TIMEOUT } = options;

  try {
    const resolvedUrl = resolveUrl(url);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      signal: controller.signal,
    };

    if (body) {
      fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const response = await fetch(resolvedUrl, fetchOptions);
    clearTimeout(timeoutId);

    const responseText = await response.text();
    const passed = expectStatus ? response.status === expectStatus : response.ok;

    return {
      success: passed,
      action: "httpRequest",
      method: method.toUpperCase(),
      url: resolvedUrl,
      statusCode: response.status,
      expectedStatus: expectStatus,
      responseBody: responseText.slice(0, 1000), // Truncate large responses
      responseHeaders: Object.fromEntries(response.headers.entries()),
      duration: Date.now() - startTime,
      error: passed
        ? undefined
        : `Expected status ${expectStatus || "2xx"} but got ${response.status}`,
    };
  } catch (error) {
    return {
      success: false,
      action: "httpRequest",
      method: method.toUpperCase(),
      url,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// TOOL DEFINITIONS FOR AGENT
// ============================================================================

/**
 * Tool definitions for agent prompt injection
 */
export const PLAYWRIGHT_TOOLS: PlaywrightToolDefinition[] = [
  {
    name: "web_navigate",
    description: "Navigate to a URL in the browser",
    parameters: {
      url: { type: "string", description: "URL to navigate to", required: true },
      waitUntil: {
        type: "string",
        description: "Wait condition: load, domcontentloaded, networkidle",
      },
    },
  },
  {
    name: "web_click",
    description:
      "Click an element. Uses smart selector resolution: testId → ariaLabel → text → AI vision",
    parameters: {
      testId: { type: "string", description: "data-testid attribute value" },
      ariaLabel: { type: "string", description: "aria-label attribute value" },
      text: { type: "string", description: "Visible text content" },
      role: { type: "string", description: "ARIA role (button, link, etc.)" },
    },
  },
  {
    name: "web_type",
    description: "Type text into an input element (appends to existing text)",
    parameters: {
      testId: { type: "string", description: "data-testid of the input" },
      ariaLabel: { type: "string", description: "aria-label of the input" },
      text: { type: "string", description: "Visible text to find input" },
      value: { type: "string", description: "Text to type", required: true },
      clear: { type: "boolean", description: "Clear field before typing" },
    },
  },
  {
    name: "web_fill",
    description: "Clear and type text into an input element (replaces existing text)",
    parameters: {
      testId: { type: "string", description: "data-testid of the input" },
      ariaLabel: { type: "string", description: "aria-label of the input" },
      text: { type: "string", description: "Visible text to find input" },
      value: { type: "string", description: "Text to fill", required: true },
    },
  },
  {
    name: "web_screenshot",
    description: "Capture a screenshot of the current page",
    parameters: {
      name: { type: "string", description: "Screenshot name for evidence" },
      fullPage: { type: "boolean", description: "Capture full page or viewport only" },
    },
  },
  {
    name: "web_assert_visible",
    description: "Assert that an element is visible on the page",
    parameters: {
      testId: { type: "string", description: "data-testid to check" },
      ariaLabel: { type: "string", description: "aria-label to check" },
      text: { type: "string", description: "Text content to find" },
      timeout: { type: "number", description: "Max wait time in ms" },
    },
  },
  {
    name: "web_assert_text",
    description: "Assert that an element contains expected text",
    parameters: {
      testId: { type: "string", description: "data-testid of element" },
      ariaLabel: { type: "string", description: "aria-label of element" },
      text: { type: "string", description: "Text to find element" },
      expected: { type: "string", description: "Expected text content", required: true },
    },
  },
  {
    name: "web_wait",
    description: "Wait for a specified duration",
    parameters: {
      ms: { type: "number", description: "Milliseconds to wait", required: true },
    },
  },
  {
    name: "web_http_request",
    description: "Make an HTTP request for API testing",
    parameters: {
      method: { type: "string", description: "HTTP method", required: true },
      url: { type: "string", description: "Request URL", required: true },
      body: { type: "string", description: "Request body as JSON string" },
      headers: { type: "object", description: "Request headers" },
      expectStatus: { type: "number", description: "Expected status code" },
    },
  },
];

/**
 * Get all Playwright tool definitions for agent injection
 */
export function getPlaywrightToolDefinitions(): PlaywrightToolDefinition[] {
  return PLAYWRIGHT_TOOLS;
}

/**
 * Format tool definitions for agent prompt
 */
export function formatPlaywrightToolsForPrompt(): string {
  return PLAYWRIGHT_TOOLS.map((tool) => {
    const params = Object.entries(tool.parameters)
      .map(
        ([name, def]) =>
          `  - ${name}: ${def.type}${def.required ? " (required)" : ""} - ${def.description}`
      )
      .join("\n");
    return `### ${tool.name}\n${tool.description}\n\n**Parameters:**\n${params}`;
  }).join("\n\n");
}

/**
 * Execute a Playwright tool by name and arguments
 */
export async function executePlaywrightTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<PlaywrightActionResult> {
  const startTime = Date.now();

  // Build selector from args if present
  const buildSelector = (): ElementSelector => ({
    testId: args.testId as string | undefined,
    ariaLabel: args.ariaLabel as string | undefined,
    role: args.role as string | undefined,
    text: args.text as string | undefined,
    css: args.css as string | undefined,
  });

  try {
    switch (toolName) {
      case "web_navigate":
        return await navigate(args.url as string, {
          waitUntil: args.waitUntil as NavigateOptions["waitUntil"],
        });

      case "web_click":
        return await click(buildSelector(), {
          captureEvidence: true,
        });

      case "web_type":
        return await type(buildSelector(), args.value as string, {
          clear: args.clear as boolean,
        });

      case "web_fill":
        return await fill(buildSelector(), args.value as string);

      case "web_screenshot": {
        const screenshotBuf = await screenshot(args.name as string, {
          fullPage: args.fullPage as boolean,
        });
        return {
          success: true,
          action: "screenshot",
          screenshot: screenshotBuf,
          duration: Date.now() - startTime,
          metadata: { name: args.name },
        };
      }

      case "web_assert_visible":
        return await assertVisible(buildSelector(), {
          timeout: args.timeout as number,
        });

      case "web_assert_text":
        return await assertText(
          buildSelector(),
          args.expected as string
        );

      case "web_wait":
        return await wait(args.ms as number);

      case "web_http_request":
        return await httpRequest(args.method as string, args.url as string, {
          body: args.body as string,
          headers: args.headers as Record<string, string>,
          expectStatus: args.expectStatus as number,
        });

      default:
        return {
          success: false,
          action: toolName,
          duration: Date.now() - startTime,
          error: `Unknown Playwright tool: ${toolName}`,
        };
    }
  } catch (error) {
    return {
      success: false,
      action: toolName,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
