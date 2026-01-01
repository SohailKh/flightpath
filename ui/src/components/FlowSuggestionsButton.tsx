import { useState } from "react";
import { Button } from "./ui/button";
import { FlowSuggestionsModal } from "./FlowSuggestionsModal";

interface FlowSuggestionsButtonProps {
  pipelineId: string;
  disabled?: boolean;
}

export function FlowSuggestionsButton({
  pipelineId,
  disabled = false,
}: FlowSuggestionsButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        disabled={disabled}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mr-1"
        >
          <path d="M12 2v4" />
          <path d="m6.8 14-3.5 2" />
          <path d="m20.7 16-3.5-2" />
          <path d="M6.8 10 3.3 8" />
          <path d="m20.7 8-3.5 2" />
          <circle cx="12" cy="12" r="4" />
        </svg>
        Suggestions
      </Button>
      {isOpen && (
        <FlowSuggestionsModal
          pipelineId={pipelineId}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
