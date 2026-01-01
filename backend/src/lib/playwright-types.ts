/**
 * Playwright Web Testing Types
 *
 * Type definitions for browser automation, element selection,
 * and test execution results.
 */

import type { ElementHandle } from "playwright";

/**
 * Element selector with priority-based resolution.
 * Selectors are tried in order: testId → ariaLabel → role → text → css
 */
export interface ElementSelector {
  /** data-testid attribute (highest priority) */
  testId?: string;
  /** aria-label attribute */
  ariaLabel?: string;
  /** ARIA role (button, link, textbox, etc.) */
  role?: string;
  /** Accessible name for role-based selection */
  roleName?: string;
  /** Visible text content */
  text?: string;
  /** Raw CSS selector (lowest priority) */
  css?: string;
}

/**
 * Methods used for selector resolution
 */
export type SelectorMethod =
  | "testId"
  | "ariaLabel"
  | "role"
  | "text"
  | "css"
  | "aiVision";

/**
 * Result of selector resolution attempt
 */
export interface SelectorResolution {
  /** Whether an element was found */
  success: boolean;
  /** The actual selector string used */
  usedSelector: string;
  /** Which method successfully found the element */
  usedMethod: SelectorMethod;
  /** All selectors that were attempted */
  fallbacksAttempted: string[];
  /** The found element handle (if successful) */
  element?: ElementHandle;
  /** Screenshot captured during AI recovery */
  recoveryScreenshot?: Buffer;
  /** Whether AI vision was used to locate the element */
  aiRecoveryUsed: boolean;
  /** Error message if resolution failed */
  error?: string;
}

/**
 * Options for selector resolution
 */
export interface ResolveOptions {
  /** Timeout for each selector attempt (ms) */
  timeout?: number;
  /** Enable AI vision recovery as fallback */
  enableAIRecovery?: boolean;
  /** Capture screenshot on success for evidence */
  captureEvidence?: boolean;
}

/**
 * Base result for all Playwright actions
 */
export interface PlaywrightActionResult {
  /** Whether the action succeeded */
  success: boolean;
  /** Action name that was executed */
  action: string;
  /** Selector used (if applicable) */
  selector?: ElementSelector;
  /** Details of how the element was found */
  resolution?: SelectorResolution;
  /** Screenshot captured after action */
  screenshot?: Buffer;
  /** Error message if action failed */
  error?: string;
  /** Action duration in milliseconds */
  duration: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of navigation action
 */
export interface NavigationResult extends PlaywrightActionResult {
  action: "navigate";
  /** URL navigated to */
  url: string;
  /** HTTP status code of navigation */
  statusCode?: number;
  /** Page title after navigation */
  title?: string;
}

/**
 * Result of type/fill action
 */
export interface TypeResult extends PlaywrightActionResult {
  action: "type" | "fill";
  /** Value that was typed */
  value: string;
  /** Whether the field was cleared first */
  cleared: boolean;
}

/**
 * Assertion types
 */
export type AssertionType =
  | "visible"
  | "hidden"
  | "enabled"
  | "disabled"
  | "checked"
  | "text";

/**
 * Result of assertion action
 */
export interface AssertionResult extends PlaywrightActionResult {
  action: "assert";
  /** Type of assertion performed */
  assertion: AssertionType;
  /** Expected value */
  expected: unknown;
  /** Actual value found */
  actual: unknown;
  /** Whether assertion passed */
  passed: boolean;
}

/**
 * Result of HTTP request action
 */
export interface HttpRequestResult extends PlaywrightActionResult {
  action: "httpRequest";
  /** HTTP method used */
  method: string;
  /** Request URL */
  url: string;
  /** Response status code */
  statusCode?: number;
  /** Expected status code (if specified) */
  expectedStatus?: number;
  /** Response body (truncated if large) */
  responseBody?: string;
  /** Response headers */
  responseHeaders?: Record<string, string>;
}

/**
 * Evidence types for test artifacts
 */
export type EvidenceType =
  | "screenshot"
  | "api-response"
  | "console-log"
  | "network-log";

/**
 * Evidence captured during test execution
 */
export interface Evidence {
  type: EvidenceType;
  path: string;
  description?: string;
}

/**
 * Result of executing a single smoke test step
 */
export interface StepExecutionResult {
  /** Index in the step sequence */
  stepIndex: number;
  /** The parsed step prefix (tap, type, etc.) */
  stepPrefix: string;
  /** The raw step string */
  rawStep: string;
  /** Result of executing the step */
  result: PlaywrightActionResult;
  /** Evidence captured for this step */
  evidence?: Evidence;
}

/**
 * Parsed step with action and parameters
 */
export interface ParsedStep {
  /** Action type (navigate, tap, type, etc.) */
  action: string;
  /** Element selector (if applicable) */
  selector?: ElementSelector;
  /** Value to type (for type/fill actions) */
  value?: string;
  /** URL for navigation */
  url?: string;
  /** Milliseconds to wait */
  ms?: number;
  /** HTTP method for curl */
  method?: string;
  /** Expected value for assertions */
  expected?: string;
  /** Expected status code for HTTP requests */
  expectStatus?: number;
  /** Screenshot name */
  name?: string;
}

/**
 * Tool definition for agent consumption
 */
export interface PlaywrightToolDefinition {
  name: string;
  description: string;
  parameters: Record<
    string,
    {
      type: string;
      description: string;
      required?: boolean;
    }
  >;
}

/**
 * Options for browser initialization
 */
export interface BrowserOptions {
  /** Run in headless mode (default: true) */
  headless?: boolean;
  /** Base URL for relative navigation */
  baseUrl?: string;
  /** Viewport size */
  viewport?: { width: number; height: number };
  /** Default timeout for actions (ms) */
  timeout?: number;
}

/**
 * Options for navigation
 */
export interface NavigateOptions {
  /** Wait condition: load, domcontentloaded, networkidle */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /** Navigation timeout (ms) */
  timeout?: number;
}

/**
 * Options for click action
 */
export interface ClickOptions extends ResolveOptions {
  /** Number of clicks (1 = single, 2 = double) */
  clickCount?: number;
  /** Mouse button to use */
  button?: "left" | "right" | "middle";
  /** Delay between mousedown and mouseup (ms) */
  delay?: number;
}

/**
 * Options for type action
 */
export interface TypeOptions extends ResolveOptions {
  /** Delay between key presses (ms) */
  delay?: number;
  /** Clear the field before typing */
  clear?: boolean;
}

/**
 * Options for screenshot
 */
export interface ScreenshotOptions {
  /** Capture full page or just viewport */
  fullPage?: boolean;
  /** Screenshot quality (0-100, only for jpeg) */
  quality?: number;
}

/**
 * Options for HTTP request
 */
export interface HttpRequestOptions {
  /** Request body (as JSON string or object) */
  body?: string | Record<string, unknown>;
  /** Request headers */
  headers?: Record<string, string>;
  /** Expected status code for assertion */
  expectStatus?: number;
  /** Request timeout (ms) */
  timeout?: number;
}

/**
 * Options for wait action
 */
export interface WaitOptions {
  /** Condition to wait for */
  state?: "visible" | "hidden" | "attached" | "detached";
  /** Timeout (ms) */
  timeout?: number;
}
