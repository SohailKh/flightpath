import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ArtifactRef, Requirement } from "../../types";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ScreenshotGallery } from "./ScreenshotGallery";
import { TestResultViewer } from "./TestResultViewer";
import { DiffViewer } from "./DiffViewer";

interface ArtifactPanelProps {
  pipelineId: string;
  artifacts: ArtifactRef[];
  requirements: Requirement[];
}

type TabType = "all" | "screenshots" | "test_results" | "diffs";

export function ArtifactPanel({
  pipelineId,
  artifacts,
  requirements,
}: ArtifactPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [selectedRequirement, setSelectedRequirement] = useState<string | null>(
    null
  );

  // Filter artifacts by type
  const screenshots = artifacts.filter((a) => a.type === "screenshot");
  const testResults = artifacts.filter((a) => a.type === "test_result");
  const diffs = artifacts.filter((a) => a.type === "diff");

  // Apply requirement filter
  const filterByRequirement = (items: ArtifactRef[]) => {
    if (!selectedRequirement) return items;
    return items.filter((a) => a.requirementId === selectedRequirement);
  };

  const filteredScreenshots = filterByRequirement(screenshots);
  const filteredTestResults = filterByRequirement(testResults);
  const filteredDiffs = filterByRequirement(diffs);

  const tabs: { id: TabType; label: string; count: number }[] = [
    { id: "all", label: "All", count: artifacts.length },
    { id: "screenshots", label: "Screenshots", count: screenshots.length },
    { id: "test_results", label: "Test Results", count: testResults.length },
    { id: "diffs", label: "Diffs", count: diffs.length },
  ];

  return (
    <Card>
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Artifacts</CardTitle>

          {/* Requirement filter */}
          {requirements.length > 0 && (
            <select
              value={selectedRequirement || ""}
              onChange={(e) =>
                setSelectedRequirement(e.target.value || null)
              }
              className="text-xs border rounded px-2 py-1 bg-white"
            >
              <option value="">All Requirements</option>
              {requirements.map((req) => (
                <option key={req.id} value={req.id}>
                  {req.title}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "px-3 py-1 text-xs rounded-full transition-colors",
                activeTab === tab.id
                  ? "bg-blue-100 text-blue-700"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              )}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1 text-xs opacity-70">({tab.count})</span>
              )}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="max-h-96 overflow-y-auto">
        {/* Screenshots */}
        {(activeTab === "all" || activeTab === "screenshots") &&
          filteredScreenshots.length > 0 && (
            <div className="mb-4">
              {activeTab === "all" && (
                <h4 className="text-xs font-medium text-gray-500 mb-2">
                  Screenshots
                </h4>
              )}
              <ScreenshotGallery
                pipelineId={pipelineId}
                screenshots={filteredScreenshots}
              />
            </div>
          )}

        {/* Test Results */}
        {(activeTab === "all" || activeTab === "test_results") &&
          filteredTestResults.length > 0 && (
            <div className="mb-4">
              {activeTab === "all" && (
                <h4 className="text-xs font-medium text-gray-500 mb-2">
                  Test Results
                </h4>
              )}
              <TestResultViewer
                pipelineId={pipelineId}
                testResults={filteredTestResults}
              />
            </div>
          )}

        {/* Diffs */}
        {(activeTab === "all" || activeTab === "diffs") &&
          filteredDiffs.length > 0 && (
            <div className="mb-4">
              {activeTab === "all" && (
                <h4 className="text-xs font-medium text-gray-500 mb-2">
                  Code Diffs
                </h4>
              )}
              <DiffViewer pipelineId={pipelineId} diffs={filteredDiffs} />
            </div>
          )}

        {/* Empty state */}
        {artifacts.length === 0 && (
          <div className="text-center text-gray-400 py-8 text-sm">
            No artifacts captured yet
          </div>
        )}

        {artifacts.length > 0 &&
          filteredScreenshots.length === 0 &&
          filteredTestResults.length === 0 &&
          filteredDiffs.length === 0 && (
            <div className="text-center text-gray-400 py-8 text-sm">
              No artifacts match the selected filter
            </div>
          )}
      </CardContent>
    </Card>
  );
}
