import { useState } from "react";
import { cn } from "@/lib/utils";
import { Card } from "./ui/card";
import type { PipelineEvent, Requirement, Epic } from "../types";
import { EpicsView } from "./EpicsView";
import { ResponseLog } from "./ResponseLog";

interface EpicsProgressPanelProps {
  events: PipelineEvent[];
  pipelineId?: string;
  requirements?: Requirement[];
  epics?: Epic[];
  onQuestionSubmit?: (
    answers: Record<string, string | string[]>,
    timestamp: string
  ) => void;
  answeredQuestions?: Set<string>;
  isSending?: boolean;
}

type TabId = "epics" | "messages";

export function EpicsProgressPanel({
  events,
  requirements = [],
  epics = [],
  onQuestionSubmit,
  answeredQuestions,
  isSending,
}: EpicsProgressPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("epics");

  return (
    <Card className="flex flex-col h-full">
      {/* Tab Header */}
      <div className="flex border-b">
        <TabButton
          active={activeTab === "epics"}
          onClick={() => setActiveTab("epics")}
          label="Epics"
          count={epics.length}
        />
        <TabButton
          active={activeTab === "messages"}
          onClick={() => setActiveTab("messages")}
          label="Messages"
        />
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "epics" ? (
          <EpicsView epics={epics} requirements={requirements} events={events} />
        ) : (
          <ResponseLog
            events={events}
            requirements={requirements}
            onQuestionSubmit={onQuestionSubmit}
            answeredQuestions={answeredQuestions}
            isSending={isSending}
          />
        )}
      </div>
    </Card>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}

function TabButton({ active, onClick, label, count }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 px-4 py-2 text-sm font-medium transition-colors relative",
        active
          ? "text-blue-600"
          : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
      )}
    >
      <span className="flex items-center justify-center gap-1.5">
        {label}
        {count !== undefined && count > 0 && (
          <span
            className={cn(
              "px-1.5 py-0.5 rounded-full text-xs",
              active ? "bg-blue-100 text-blue-600" : "bg-gray-100 text-gray-500"
            )}
          >
            {count}
          </span>
        )}
      </span>
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600" />
      )}
    </button>
  );
}
