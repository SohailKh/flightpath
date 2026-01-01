/**
 * Playwright Intelligent Selector Resolution
 *
 * Provides priority-based element selection with automatic fallbacks:
 * testId → ariaLabel → role → text → css → AI vision recovery
 */

import type { Page, ElementHandle } from "playwright";
import type {
  ElementSelector,
  SelectorMethod,
  SelectorResolution,
  ResolveOptions,
  ParsedStep,
} from "./playwright-types";

// Default timeout per selector method (ms)
const DEFAULT_TIMEOUT_PER_METHOD = 2000;

// Total timeout before giving up
const DEFAULT_TOTAL_TIMEOUT = 10000;

/**
 * Build a Playwright selector string for a given method
 */
function buildSelector(
  method: SelectorMethod,
  selector: ElementSelector
): string | null {
  switch (method) {
    case "testId":
      return selector.testId ? `[data-testid="${selector.testId}"]` : null;
    case "ariaLabel":
      return selector.ariaLabel
        ? `[aria-label="${selector.ariaLabel}"]`
        : null;
    case "role":
      if (!selector.role) return null;
      // Playwright's role selector with optional name
      if (selector.roleName) {
        return `role=${selector.role}[name="${selector.roleName}"]`;
      }
      return `role=${selector.role}`;
    case "text":
      return selector.text ? `text="${selector.text}"` : null;
    case "css":
      return selector.css || null;
    default:
      return null;
  }
}

/**
 * Attempt to find element using a specific selector method
 */
async function trySelector(
  page: Page,
  method: SelectorMethod,
  selector: ElementSelector,
  timeout: number
): Promise<ElementHandle | null> {
  const selectorString = buildSelector(method, selector);
  if (!selectorString) return null;

  try {
    const element = await page.waitForSelector(selectorString, {
      timeout,
      state: "visible",
    });
    return element;
  } catch {
    return null;
  }
}

/**
 * Attempt AI vision-based element recovery
 * Uses Claude vision to locate element from screenshot when all selectors fail
 */
async function attemptAIVisionRecovery(
  page: Page,
  selector: ElementSelector,
  fallbacksAttempted: string[]
): Promise<SelectorResolution> {
  try {
    // Check for API key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        usedSelector: "",
        usedMethod: "aiVision",
        fallbacksAttempted,
        aiRecoveryUsed: false,
        error: "AI vision recovery skipped: ANTHROPIC_API_KEY not set",
      };
    }

    // Capture screenshot for vision analysis
    const screenshot = await page.screenshot({ fullPage: false });
    const base64Image = screenshot.toString("base64");

    // Build description of what we're looking for
    const selectorDescription = Object.entries(selector)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: "${v}"`)
      .join(", ");

    // Call Claude vision API via fetch
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: base64Image,
                },
              },
              {
                type: "text",
                text: `I need to locate an element on this web page.

Target element: ${selectorDescription}

Analyze the screenshot and provide the best CSS selector to find this element.
If the element is not visible on the page, explain why.

Respond in this JSON format:
{
  "found": true/false,
  "selector": "CSS selector string",
  "confidence": "high/medium/low",
  "reason": "explanation"
}`,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Vision API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    // Parse the response
    const content = data.content[0];
    if (content.type !== "text" || !content.text) {
      throw new Error("Unexpected response type from vision API");
    }

    // Extract JSON from response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Could not parse JSON from vision response");
    }

    const visionResult = JSON.parse(jsonMatch[0]) as {
      found: boolean;
      selector?: string;
      confidence?: string;
      reason?: string;
    };

    if (visionResult.found && visionResult.selector) {
      // Try the AI-suggested selector
      try {
        const element = await page.waitForSelector(visionResult.selector, {
          timeout: 5000,
          state: "visible",
        });

        if (element) {
          return {
            success: true,
            usedSelector: visionResult.selector,
            usedMethod: "aiVision",
            fallbacksAttempted,
            element,
            recoveryScreenshot: screenshot,
            aiRecoveryUsed: true,
          };
        }
      } catch {
        // AI selector didn't work either
      }
    }

    return {
      success: false,
      usedSelector: "",
      usedMethod: "aiVision",
      fallbacksAttempted,
      recoveryScreenshot: screenshot,
      aiRecoveryUsed: true,
      error: visionResult.reason || "AI vision could not locate element",
    };
  } catch (error) {
    return {
      success: false,
      usedSelector: "",
      usedMethod: "aiVision",
      fallbacksAttempted,
      aiRecoveryUsed: true,
      error: `AI vision recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Resolve an element using priority-based selector chain
 *
 * Priority: data-testid > aria-label > role > text > CSS > AI vision
 *
 * @param page - Playwright page instance
 * @param selector - Element selector with multiple strategies
 * @param options - Resolution options
 * @returns Resolution result with found element or error
 */
export async function resolveElement(
  page: Page,
  selector: ElementSelector,
  options: ResolveOptions = {}
): Promise<SelectorResolution> {
  const {
    timeout = DEFAULT_TOTAL_TIMEOUT,
    enableAIRecovery = true,
  } = options;

  const fallbacksAttempted: string[] = [];
  const methods: SelectorMethod[] = ["testId", "ariaLabel", "role", "text", "css"];

  // Calculate timeout per method
  const timeoutPerMethod = Math.min(
    DEFAULT_TIMEOUT_PER_METHOD,
    timeout / methods.length
  );

  // Try each selector method in priority order
  for (const method of methods) {
    const selectorString = buildSelector(method, selector);
    if (!selectorString) continue;

    fallbacksAttempted.push(`${method}: ${selectorString}`);

    const element = await trySelector(page, method, selector, timeoutPerMethod);

    if (element) {
      return {
        success: true,
        usedSelector: selectorString,
        usedMethod: method,
        fallbacksAttempted,
        element,
        aiRecoveryUsed: false,
      };
    }
  }

  // All standard selectors failed - try AI vision recovery
  if (enableAIRecovery) {
    return attemptAIVisionRecovery(page, selector, fallbacksAttempted);
  }

  return {
    success: false,
    usedSelector: "",
    usedMethod: "testId",
    fallbacksAttempted,
    aiRecoveryUsed: false,
    error: `Element not found. Tried: ${fallbacksAttempted.join(", ")}`,
  };
}

/**
 * Parse step prefix to extract selector and parameters
 *
 * Examples:
 *   "tap:testId=submit-btn" → { action: "tap", selector: { testId: "submit-btn" } }
 *   "type:testId=email value=test@example.com" → { action: "type", selector: { testId: "email" }, value: "test@example.com" }
 *   "curl:POST /api/users expect=201" → { action: "curl", method: "POST", url: "/api/users", expectStatus: 201 }
 *   "navigate:url=http://localhost:3000" → { action: "navigate", url: "http://localhost:3000" }
 *   "screenshot:name=home" → { action: "screenshot", name: "home" }
 *   "wait:ms=1000" → { action: "wait", ms: 1000 }
 */
export function parseStep(step: string): ParsedStep {
  // Handle simple actions without parameters
  if (!step.includes(":")) {
    return { action: step };
  }

  // Split action from parameters
  const colonIndex = step.indexOf(":");
  const action = step.substring(0, colonIndex);
  const paramsStr = step.substring(colonIndex + 1);

  const result: ParsedStep = { action };

  // Handle curl special format: "curl:METHOD /path expect=CODE"
  if (action === "curl") {
    const curlMatch = paramsStr.match(/^(\w+)\s+(\S+)(?:\s+expect=(\d+))?/);
    if (curlMatch) {
      result.method = curlMatch[1];
      result.url = curlMatch[2];
      if (curlMatch[3]) {
        result.expectStatus = parseInt(curlMatch[3], 10);
      }
    }
    return result;
  }

  // Parse key=value pairs
  // Handle values that may contain = (like URLs)
  const params: Record<string, string> = {};
  const paramRegex = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let match;

  while ((match = paramRegex.exec(paramsStr)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3]; // Quoted or unquoted
    params[key] = value;
  }

  // Build selector from params
  const selector: ElementSelector = {};
  if (params.testId) selector.testId = params.testId;
  if (params.ariaLabel) selector.ariaLabel = params.ariaLabel;
  if (params.role) selector.role = params.role;
  if (params.text) selector.text = params.text;
  if (params.css) selector.css = params.css;

  // Only add selector if we have any selector properties
  if (Object.keys(selector).length > 0) {
    result.selector = selector;
  }

  // Extract other parameters
  if (params.value) result.value = params.value;
  if (params.url) result.url = params.url;
  if (params.ms) result.ms = parseInt(params.ms, 10);
  if (params.expect) result.expected = params.expect;
  if (params.expectStatus) result.expectStatus = parseInt(params.expectStatus, 10);
  if (params.name) result.name = params.name;

  return result;
}

/**
 * Format selector for logging
 */
export function formatSelector(selector: ElementSelector): string {
  const parts: string[] = [];
  if (selector.testId) parts.push(`testId="${selector.testId}"`);
  if (selector.ariaLabel) parts.push(`ariaLabel="${selector.ariaLabel}"`);
  if (selector.role) parts.push(`role="${selector.role}"`);
  if (selector.text) parts.push(`text="${selector.text}"`);
  if (selector.css) parts.push(`css="${selector.css}"`);
  return parts.join(", ") || "(empty selector)";
}

/**
 * Log selector resolution for debugging
 */
export function logSelectorResolution(
  resolution: SelectorResolution,
  logger: (msg: string) => void = console.log
): void {
  if (resolution.success) {
    logger(
      `[Selector] Found via ${resolution.usedMethod}: ${resolution.usedSelector}` +
        (resolution.aiRecoveryUsed ? " (AI recovery)" : "")
    );
  } else {
    logger(
      `[Selector] Failed to find element. Attempted: ${resolution.fallbacksAttempted.join(" → ")}`
    );
    if (resolution.error) {
      logger(`[Selector] Error: ${resolution.error}`);
    }
  }
}
