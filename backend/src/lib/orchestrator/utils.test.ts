import { describe, expect, it } from "bun:test";
import { formatArgsPreview, truncateResult } from "./utils";

describe("formatArgsPreview", () => {
  it("returns empty string for non-object", () => {
    expect(formatArgsPreview(null)).toBe("");
    expect(formatArgsPreview("text")).toBe("");
  });

  it("handles file_path", () => {
    expect(formatArgsPreview({ file_path: "/tmp/file.ts" })).toBe("/tmp/file.ts");
  });

  it("truncates long command", () => {
    const longCommand = "a".repeat(70);
    const preview = formatArgsPreview({ command: longCommand });
    expect(preview.length).toBe(60);
    expect(preview.endsWith("...")).toBe(true);
  });

  it("formats pattern and content", () => {
    expect(formatArgsPreview({ pattern: "*.ts" })).toBe('pattern="*.ts"');
    expect(formatArgsPreview({ content: "hello" })).toBe("[content: 5 chars]");
  });

  it("truncates long JSON", () => {
    const obj = { a: "x".repeat(100) };
    const preview = formatArgsPreview(obj);
    expect(preview.length).toBe(80);
    expect(preview.endsWith("...")).toBe(true);
  });
});

describe("truncateResult", () => {
  it("returns short strings unchanged", () => {
    expect(truncateResult("short")).toBe("short");
  });

  it("truncates long strings", () => {
    const longText = "a".repeat(250);
    const truncated = truncateResult(longText);
    expect(truncated.length).toBe(200);
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("handles objects", () => {
    const result = truncateResult({ ok: true });
    expect(result).toBe("{\"ok\":true}");
  });
});
