import { readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

export interface PlatformConfig {
  enabled: boolean;
  directory: string;
  packageManager: "npm" | "bun" | "pnpm" | "yarn";
  typeCheckCommand: string;
  devCommand?: string;
  healthCheckUrl?: string;
  framework?: string;
}

export interface ProjectConfig {
  project: {
    name: string;
  };
  author: {
    branchPrefix: string;
  };
  platforms: Record<string, PlatformConfig>;
  defaults: {
    primaryPlatform: string;
    packageManager: "npm" | "bun" | "pnpm" | "yarn";
  };
}

const DEFAULT_CONFIG: ProjectConfig = {
  project: { name: "project" },
  author: { branchPrefix: "feature" },
  platforms: {},
  defaults: { primaryPlatform: "backend", packageManager: "npm" },
};

/**
 * Load project config from target project's .claude/project-config.json
 */
export async function loadProjectConfig(
  projectPath: string
): Promise<ProjectConfig> {
  const configPath = path.join(projectPath, ".claude", "project-config.json");

  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content) as Partial<ProjectConfig>;
    return {
      project: { ...DEFAULT_CONFIG.project, ...config.project },
      author: { ...DEFAULT_CONFIG.author, ...config.author },
      platforms: config.platforms ?? DEFAULT_CONFIG.platforms,
      defaults: { ...DEFAULT_CONFIG.defaults, ...config.defaults },
    };
  } catch {
    console.error(`Error loading project config from ${configPath}`);
    return DEFAULT_CONFIG;
  }
}

/**
 * Generate a Project Context section to inject into agent prompts
 */
export function generateProjectContext(config: ProjectConfig): string {
  const enabledPlatforms = Object.entries(config.platforms).filter(
    ([_, p]) => p.enabled
  );

  if (enabledPlatforms.length === 0) {
    return `## Project Context

**Project:** ${config.project.name}
**Branch Prefix:** ${config.author.branchPrefix}

No platforms configured. Use sensible defaults based on the project structure.

---`;
  }

  let context = `## Project Context

**Project:** ${config.project.name}
**Branch Prefix:** ${config.author.branchPrefix}
**Primary Platform:** ${config.defaults.primaryPlatform}

### Platforms
`;

  for (const [name, platform] of enabledPlatforms) {
    context += `
**${name}:**
- Directory: \`${platform.directory}/\`
- Package Manager: \`${platform.packageManager}\`
- Type Check: \`cd ${platform.directory} && ${platform.typeCheckCommand}\``;

    if (platform.devCommand) {
      context += `
- Dev Server: \`cd ${platform.directory} && ${platform.devCommand}\``;
    }
    if (platform.healthCheckUrl) {
      context += `
- Health Check: \`${platform.healthCheckUrl}\``;
    }
    context += "\n";
  }

  context += `
### Branch Naming
\`${config.author.branchPrefix}/{feature-name}-{YYYYMMDD}\`

---`;

  return context;
}
