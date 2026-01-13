import { beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

mock.restore();

let exists = true;
let readFileContent = "";
const mkdir = jest.fn(async () => {});
const copyFile = jest.fn(async () => {});
const execCalls: Array<{ cmd: string; options?: Record<string, unknown> }> = [];
let execError: Error | null = null;
let execStdout = "";
let execStderr = "";

const exec = (
  cmd: string,
  options: Record<string, unknown> | ((error: Error | null, stdout: string, stderr: string) => void),
  callback?: (error: Error | null, stdout: string, stderr: string) => void
) => {
  const cb = typeof options === "function" ? options : callback;
  execCalls.push({ cmd, options: typeof options === "function" ? undefined : options });
  if (!cb) return;
  if (execError) {
    cb(execError, "", "");
    return;
  }
  cb(null, execStdout, execStderr);
};

mock.module("node:fs", () => ({
  existsSync: () => exists,
}));

mock.module("node:fs/promises", () => ({
  readFile: async () => readFileContent,
  mkdir,
  copyFile,
}));

mock.module("node:child_process", () => ({ exec }));

const projectInit = await import(`./project-init?test=${Date.now()}`);

beforeEach(() => {
  exists = true;
  readFileContent = "";
  execStdout = "";
  execStderr = "";
  execError = null;
  execCalls.length = 0;
  mkdir.mockClear();
  copyFile.mockClear();
});

describe("sanitizeProjectName", () => {
  it("normalizes names", () => {
    expect(projectInit.sanitizeProjectName("  My Project!  ")).toBe("my-project");
    expect(projectInit.sanitizeProjectName("Project 123")).toBe("project-123");
  });

  it("falls back to untitled-project", () => {
    expect(projectInit.sanitizeProjectName("!!!")).toBe("untitled-project");
  });
});

describe("generateTargetProjectPath", () => {
  it("uses homedir and sanitized name", () => {
    const targetPath = projectInit.generateTargetProjectPath("My Project");
    const expected = join(homedir(), "flightpath-projects", "my-project");
    expect(targetPath).toBe(expected);
  });
});

describe("initializeTargetProject", () => {
  it("creates directories, initializes git, and copies spec", async () => {
    const targetPath = "/tmp/target-project";

    await projectInit.initializeTargetProject(targetPath);

    const claudeDir = join(targetPath, ".claude", "pipeline");
    expect(mkdir).toHaveBeenCalledWith(claudeDir, { recursive: true });

    expect(execCalls).toEqual([
      { cmd: "git init", options: { cwd: targetPath } },
    ]);

    const sourceSpec = join(
      projectInit.FLIGHTPATH_ROOT,
      ".claude",
      "pipeline",
      "feature-spec.v3.json"
    );
    const targetSpec = join(claudeDir, "feature-spec.v3.json");

    expect(copyFile).toHaveBeenCalledWith(sourceSpec, targetSpec);
  });
});

describe("parseRequirementsFromSpec", () => {
  it("returns empty results when spec missing", async () => {
    exists = false;
    const result = await projectInit.parseRequirementsFromSpec();
    expect(result).toEqual({
      requirements: [],
      epics: [],
      projectName: "untitled-project",
      featurePrefix: "untitled",
    });
  });

  it("handles missing requirements array", async () => {
    exists = true;
    readFileContent = JSON.stringify({ projectName: "No Req" });

    const result = await projectInit.parseRequirementsFromSpec();
    expect(result.projectName).toBe("No Req");
    expect(result.requirements).toEqual([]);
    expect(result.epics).toEqual([]);
  });

  it("parses requirements and epics with linking", async () => {
    exists = true;
    readFileContent = JSON.stringify({
      featureName: "Cool App",
      requirements: [
        {
          title: "Req A",
          description: "First",
          priority: 1,
          acceptanceCriteria: ["A1"],
          epicId: "epic-1",
        },
        {
          id: "req-2",
          title: "Req B",
          description: "Second",
          priority: 2,
        },
      ],
      epics: [
        {
          id: "epic-1",
          title: "Epic",
          goal: "Goal",
          priority: 5,
          definitionOfDone: "Done",
          keyScreens: ["Home"],
          smokeTestIds: ["smoke-1"],
        },
      ],
    });

    const result = await projectInit.parseRequirementsFromSpec();

    expect(result.projectName).toBe("Cool App");
    expect(result.requirements[0].id).toBe("req-1");
    expect(result.requirements[0].acceptanceCriteria).toEqual(["A1"]);

    const epic = result.epics[0];
    expect(epic.requirementIds).toEqual(["req-1"]);
    expect(epic.progress).toEqual({ total: 1, completed: 0, failed: 0, inProgress: 0 });
  });
});
