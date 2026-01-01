import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { analyzeFlow } from "../lib/api";
import type { FlowAnalysisResult } from "../types";
import { Button } from "./ui/button";

interface FlowSuggestionsModalProps {
  pipelineId: string;
  onClose: () => void;
}

type TabId = "suggestions" | "prompt" | "data";

export function FlowSuggestionsModal({
  pipelineId,
  onClose,
}: FlowSuggestionsModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FlowAnalysisResult | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("suggestions");
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  useEffect(() => {
    analyzeFlow(pipelineId)
      .then(setResult)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [pipelineId]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const handleCopy = useCallback(async (text: string, section: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSection(section);
      setTimeout(() => setCopiedSection(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, []);

  const tabs: { id: TabId; label: string }[] = [
    { id: "suggestions", label: "Suggestions" },
    { id: "prompt", label: "Claude Code Prompt" },
    { id: "data", label: "Analysis Data" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Flow Improvement Suggestions
            </h2>
            {result?.metadata && (
              <p className="text-sm text-gray-500">
                {result.metadata.toolCallCount} tool calls |{" "}
                {result.metadata.errorCount} errors | {result.metadata.duration}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b px-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors",
                activeTab === tab.id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="flex flex-col items-center gap-3">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-600 border-t-transparent" />
                <p className="text-gray-500">Analyzing pipeline flow...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <p className="text-red-600 font-medium">Analysis Failed</p>
                <p className="text-gray-500 text-sm mt-1">{error}</p>
              </div>
            </div>
          ) : result ? (
            <>
              {activeTab === "suggestions" && (
                <SuggestionsPane
                  content={result.suggestions}
                  onCopy={() =>
                    handleCopy(result.suggestions, "suggestions")
                  }
                  copied={copiedSection === "suggestions"}
                />
              )}
              {activeTab === "prompt" && (
                <PromptPane
                  content={result.claudeCodePrompt}
                  onCopy={() =>
                    handleCopy(result.claudeCodePrompt, "prompt")
                  }
                  copied={copiedSection === "prompt"}
                />
              )}
              {activeTab === "data" && (
                <DataPane
                  content={result.contextData}
                  onCopy={() => handleCopy(result.contextData, "data")}
                  copied={copiedSection === "data"}
                />
              )}
            </>
          ) : null}
        </div>

        {/* Footer */}
        {result && (
          <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50">
            <p className="text-xs text-gray-500">
              Analyzed at{" "}
              {new Date(result.metadata.analyzedAt).toLocaleString()}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const text =
                    activeTab === "suggestions"
                      ? result.suggestions
                      : activeTab === "prompt"
                      ? result.claudeCodePrompt
                      : result.contextData;
                  handleCopy(text, activeTab);
                }}
              >
                {copiedSection === activeTab ? "Copied!" : "Copy to Clipboard"}
              </Button>
              <Button size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface PaneProps {
  content: string;
  onCopy: () => void;
  copied: boolean;
}

function SuggestionsPane({ content }: PaneProps) {
  // Render markdown-like content with basic formatting
  const lines = content.split("\n");

  return (
    <div className="prose prose-sm max-w-none">
      {lines.map((line, i) => {
        // Headings
        if (line.startsWith("### ")) {
          return (
            <h3
              key={i}
              className="text-base font-semibold text-gray-900 mt-6 mb-2"
            >
              {line.replace("### ", "")}
            </h3>
          );
        }
        if (line.startsWith("## ")) {
          return (
            <h2
              key={i}
              className="text-lg font-semibold text-gray-900 mt-6 mb-3"
            >
              {line.replace("## ", "")}
            </h2>
          );
        }
        if (line.startsWith("# ")) {
          return (
            <h1
              key={i}
              className="text-xl font-bold text-gray-900 mt-4 mb-4"
            >
              {line.replace("# ", "")}
            </h1>
          );
        }
        // Bold text
        if (line.startsWith("**") && line.endsWith("**")) {
          return (
            <p key={i} className="font-semibold text-gray-800 mt-2">
              {line.replace(/\*\*/g, "")}
            </p>
          );
        }
        // List items
        if (line.startsWith("- ")) {
          return (
            <li key={i} className="text-gray-700 ml-4">
              {line.replace("- ", "")}
            </li>
          );
        }
        // Regular text
        if (line.trim()) {
          return (
            <p key={i} className="text-gray-700 leading-relaxed">
              {line}
            </p>
          );
        }
        // Empty line
        return <div key={i} className="h-2" />;
      })}
    </div>
  );
}

function PromptPane({ content, onCopy, copied }: PaneProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Copy this prompt and paste it into Claude Code to implement the
          suggested improvements.
        </p>
        <button
          onClick={onCopy}
          className="text-sm text-blue-600 hover:text-blue-800 font-medium"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm overflow-x-auto whitespace-pre-wrap font-mono">
        {content}
      </pre>
    </div>
  );
}

function DataPane({ content, onCopy, copied }: PaneProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Raw analysis data. Copy and paste this into Claude Code to get
          different suggestions or ask specific questions.
        </p>
        <button
          onClick={onCopy}
          className="text-sm text-blue-600 hover:text-blue-800 font-medium"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="bg-gray-50 border border-gray-200 p-4 rounded-lg text-sm overflow-x-auto whitespace-pre-wrap font-mono text-gray-800">
        {content}
      </pre>
    </div>
  );
}
