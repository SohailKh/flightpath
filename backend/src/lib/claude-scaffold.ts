import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const PROJECT_CLAUDE_TEMPLATE = `# Claude Project Guide

This file provides repo-level guidance for Claude Code.

## Key Paths
- <fill: main app, server, packages, etc>

## Commands
- dev: <fill>
- test: <fill>
- lint: <fill>
- build: <fill>

## Conventions
- <fill: state management>
- <fill: routing>
- <fill: API clients>

## Rules
- .claude/rules/code-style.md
- .claude/rules/testing.md
`;

const RULE_TEMPLATES: Record<string, string> = {
  "code-style.md": `# Code Style

- Follow existing patterns and formatting.
- Prefer small, focused changes over large refactors.
- Keep names consistent with the surrounding code.
`,
  "testing.md": `# Testing

- Add or update tests that cover changed behavior.
- Use existing test tooling and keep tests deterministic.
- Note gaps if tests are deferred.
`,
};

const SKILL_TEMPLATES: Record<string, string> = {
  ux: `---
name: ux
description: Use when designing UI flows, layouts, or interaction patterns.
---

Checklist:
- Identify the primary user goal and success path.
- Cover empty, loading, and error states.
- Check accessibility and responsive behavior.

Examples:
- For a signup flow, map each step and required validation.
`,
  auth: `---
name: auth
description: Use when implementing login, session, or permission features.
---

Checklist:
- Identify trust boundaries and auth mechanism.
- Store tokens safely (avoid secrets in the client).
- Handle expiration, refresh, and logout flows.

Examples:
- For JWT sessions, prefer httpOnly cookies and CSRF protection.
`,
  patterns: `---
name: patterns
description: Use when introducing or evaluating architecture patterns.
---

Checklist:
- Reuse existing patterns before adding new ones.
- Keep abstractions minimal and well-scoped.
- Document conventions near the code.

Examples:
- For a new data layer, match existing repository/service separation.
`,
  testing: `---
name: testing
description: Use when planning or writing tests.
---

Checklist:
- Choose unit vs integration vs e2e based on risk.
- Focus on core flows and regression-prone areas.
- Keep tests deterministic and fast.

Playwright tools:
- web_navigate(url)
- web_click({ testId | ariaLabel | role | text | css })
- web_type({ ... }, value, clear?)
- web_fill({ ... }, value)
- web_assert_visible({ ... })
- web_assert_text({ ... }, expected)
- web_wait(ms)
- web_screenshot(name)
- web_http_request(method, url, body?, headers?, expectStatus?)

Examples:
- For a form, test validation, submission success, and failure.
`,
};

const LOCAL_CLAUDE_TEMPLATE = `# CLAUDE.local.md

## Local Commands
- dev: <fill>
- test: <fill>

## Conventions
- State management: <fill>
- Routing: <fill>
- API clients: <fill>

## Footguns
- <fill>
`;

const CONTEXT_ROOT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "deno.json",
  "deno.jsonc",
  "Makefile",
];

const SKIP_PATH_SEGMENTS = new Set([
  ".git",
  ".claude",
  ".flightpath",
  "node_modules",
]);

async function writeFileIfMissing(filePath: string, contents: string): Promise<void> {
  if (existsSync(filePath)) return;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf-8");
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, filePath);
  if (!relativePath) return true;
  return !relativePath.startsWith("..");
}

function shouldSkipPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.some((segment) => SKIP_PATH_SEGMENTS.has(segment));
}

function hasContextRootMarker(dirPath: string): boolean {
  if (existsSync(join(dirPath, "CLAUDE.local.md"))) return true;
  if (existsSync(join(dirPath, "CLAUDE.md"))) return true;
  return CONTEXT_ROOT_MARKERS.some((marker) => existsSync(join(dirPath, marker)));
}

function findContextRoot(filePath: string, projectRoot: string): string | null {
  let current = dirname(filePath);
  const resolvedProjectRoot = resolve(projectRoot);

  while (isWithinRoot(current, resolvedProjectRoot)) {
    if (hasContextRootMarker(current)) return current;
    if (current === resolvedProjectRoot) break;
    current = dirname(current);
  }

  return resolvedProjectRoot;
}

export async function ensureProjectClaudeLayout(projectRoot: string): Promise<void> {
  if (!projectRoot) return;
  const resolvedRoot = resolve(projectRoot);
  const claudeDir = join(resolvedRoot, ".claude");

  await mkdir(claudeDir, { recursive: true });
  await writeFileIfMissing(join(claudeDir, "CLAUDE.md"), PROJECT_CLAUDE_TEMPLATE);

  const rulesDir = join(claudeDir, "rules");
  await mkdir(rulesDir, { recursive: true });
  await Promise.all(
    Object.entries(RULE_TEMPLATES).map(([name, contents]) =>
      writeFileIfMissing(join(rulesDir, name), contents)
    )
  );

  const skillsDir = join(claudeDir, "skills");
  await mkdir(skillsDir, { recursive: true });
  await Promise.all(
    Object.entries(SKILL_TEMPLATES).map(async ([skillName, contents]) => {
      const skillDir = join(skillsDir, skillName);
      await mkdir(skillDir, { recursive: true });
      await writeFileIfMissing(join(skillDir, "SKILL.md"), contents);
    })
  );
}

export async function ensureLocalClaudeForToolInput(
  toolName: string,
  toolInput: unknown,
  projectRoot?: string
): Promise<void> {
  if (!projectRoot) return;
  if (!["Read", "Edit", "Write"].includes(toolName)) return;
  if (!toolInput || typeof toolInput !== "object") return;

  const filePath = (toolInput as { file_path?: string }).file_path;
  if (!filePath) return;

  await ensureLocalClaudeForPath(filePath, projectRoot);
}

export async function ensureLocalClaudeForPath(
  filePath: string,
  projectRoot: string
): Promise<void> {
  const resolvedRoot = resolve(projectRoot);
  const resolvedPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(resolvedRoot, filePath);

  if (!isWithinRoot(resolvedPath, resolvedRoot)) return;
  if (shouldSkipPath(resolvedPath)) return;

  const base = basename(resolvedPath);
  if (base === "CLAUDE.md" || base === "CLAUDE.local.md") return;

  const contextRoot = findContextRoot(resolvedPath, resolvedRoot);
  if (!contextRoot) return;

  const existingClaude = join(contextRoot, "CLAUDE.md");
  const existingLocal = join(contextRoot, "CLAUDE.local.md");
  if (existsSync(existingClaude) || existsSync(existingLocal)) return;

  await writeFileIfMissing(
    join(contextRoot, "CLAUDE.local.md"),
    LOCAL_CLAUDE_TEMPLATE
  );
}
