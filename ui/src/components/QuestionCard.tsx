import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { AskUserQuestion } from "../types";

interface QuestionCardProps {
  questions: AskUserQuestion[];
  onSubmit: (answers: Record<string, string | string[]>) => void;
  onSkipAll?: () => void;
  disabled?: boolean;
}

type SelectionState = Record<string, string | string[]>;

export function QuestionCard({ questions, onSubmit, onSkipAll, disabled }: QuestionCardProps) {
  const [activeQuestionIdx, setActiveQuestionIdx] = useState(0);
  const [selections, setSelections] = useState<SelectionState>({});
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({});
  const [skippedQuestions, setSkippedQuestions] = useState<Set<number>>(new Set());

  const activeQuestion = questions[activeQuestionIdx];
  const isLastQuestion = activeQuestionIdx === questions.length - 1;
  const showTabs = questions.length > 1;

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleSkipAll();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const handleOptionClick = (questionIdx: number, optionLabel: string, multiSelect: boolean) => {
    const key = `q${questionIdx}`;

    if (multiSelect) {
      const current = (selections[key] as string[]) || [];
      if (current.includes(optionLabel)) {
        setSelections({ ...selections, [key]: current.filter(o => o !== optionLabel) });
      } else {
        setSelections({ ...selections, [key]: [...current, optionLabel] });
      }
      // Clear "Other" if selecting a predefined option
      if (otherInputs[key]) {
        setOtherInputs({ ...otherInputs, [key]: "" });
      }
    } else {
      setSelections({ ...selections, [key]: optionLabel });
      // Clear "Other" if selecting a predefined option
      if (otherInputs[key]) {
        setOtherInputs({ ...otherInputs, [key]: "" });
      }
    }

    // Remove from skipped if user makes a selection
    if (skippedQuestions.has(questionIdx)) {
      setSkippedQuestions(prev => {
        const next = new Set(prev);
        next.delete(questionIdx);
        return next;
      });
    }
  };

  const handleOtherClick = (questionIdx: number, multiSelect: boolean) => {
    const key = `q${questionIdx}`;
    if (!multiSelect) {
      // For single-select, clear predefined selection when clicking Other
      setSelections({ ...selections, [key]: "" });
    }
    // Remove from skipped if user interacts with Other
    if (skippedQuestions.has(questionIdx)) {
      setSkippedQuestions(prev => {
        const next = new Set(prev);
        next.delete(questionIdx);
        return next;
      });
    }
  };

  const handleOtherChange = (questionIdx: number, value: string) => {
    const key = `q${questionIdx}`;
    setOtherInputs({ ...otherInputs, [key]: value });
  };

  const isOptionSelected = (questionIdx: number, optionLabel: string, multiSelect: boolean): boolean => {
    const key = `q${questionIdx}`;
    if (multiSelect) {
      return ((selections[key] as string[]) || []).includes(optionLabel);
    }
    return selections[key] === optionLabel;
  };

  const isOtherSelected = (questionIdx: number, multiSelect: boolean): boolean => {
    const key = `q${questionIdx}`;
    if (multiSelect) {
      return !!otherInputs[key];
    }
    return !selections[key] && !!otherInputs[key];
  };

  const hasSelectionForQuestion = (questionIdx: number): boolean => {
    const q = questions[questionIdx];
    const key = `q${questionIdx}`;
    if (q.multiSelect) {
      const selected = (selections[key] as string[]) || [];
      return selected.length > 0 || !!otherInputs[key]?.trim();
    }
    return !!selections[key] || !!otherInputs[key]?.trim();
  };

  const getQuestionStatus = (questionIdx: number): "answered" | "skipped" | "pending" => {
    if (skippedQuestions.has(questionIdx)) return "skipped";
    if (hasSelectionForQuestion(questionIdx)) return "answered";
    return "pending";
  };

  const handleSkip = () => {
    // Mark current question as skipped
    setSkippedQuestions(prev => new Set(prev).add(activeQuestionIdx));

    // Clear any selections for this question
    const key = `q${activeQuestionIdx}`;
    const newSelections = { ...selections };
    delete newSelections[key];
    setSelections(newSelections);

    const newOtherInputs = { ...otherInputs };
    delete newOtherInputs[key];
    setOtherInputs(newOtherInputs);

    // Move to next question or submit if last
    if (isLastQuestion) {
      handleSubmit();
    } else {
      setActiveQuestionIdx(prev => prev + 1);
    }
  };

  const handleNext = () => {
    if (isLastQuestion) {
      handleSubmit();
    } else {
      setActiveQuestionIdx(prev => prev + 1);
    }
  };

  const handleSkipAll = () => {
    if (onSkipAll) {
      onSkipAll();
    } else {
      // If no onSkipAll handler, submit with empty answers
      onSubmit({});
    }
  };

  const handleSubmit = () => {
    const answers: Record<string, string | string[]> = {};

    questions.forEach((q, idx) => {
      // Skip questions that were skipped
      if (skippedQuestions.has(idx)) return;

      const key = `q${idx}`;
      const otherValue = otherInputs[key]?.trim();

      if (q.multiSelect) {
        const selected = (selections[key] as string[]) || [];
        if (selected.length > 0 || otherValue) {
          if (otherValue) {
            answers[q.header] = [...selected, `Other: ${otherValue}`];
          } else {
            answers[q.header] = selected;
          }
        }
      } else {
        if (otherValue && !selections[key]) {
          answers[q.header] = `Other: ${otherValue}`;
        } else if (selections[key]) {
          answers[q.header] = selections[key] as string;
        }
      }
    });

    onSubmit(answers);
  };

  const currentHasSelection = hasSelectionForQuestion(activeQuestionIdx);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={handleSkipAll}
    >
      <div
        className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">
            {questions.length === 1 ? "Question" : "Questions"}
          </h2>
          <button
            onClick={handleSkipAll}
            className="text-sm text-gray-500 hover:text-gray-700 font-medium"
          >
            Skip All
          </button>
        </div>

        {/* Tabs */}
        {showTabs && (
          <div className="flex border-b px-6 overflow-x-auto">
            {questions.map((q, idx) => {
              const status = getQuestionStatus(idx);
              return (
                <button
                  key={idx}
                  onClick={() => setActiveQuestionIdx(idx)}
                  className={cn(
                    "px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex items-center gap-2",
                    activeQuestionIdx === idx
                      ? "border-blue-600 text-blue-600"
                      : "border-transparent text-gray-500 hover:text-gray-700"
                  )}
                >
                  {q.header}
                  {status === "answered" && (
                    <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                  {status === "skipped" && (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Question Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-4">
            {/* Question text */}
            <p className="text-base font-medium text-gray-900">{activeQuestion.question}</p>

            {/* Options */}
            <div className="space-y-2">
              {activeQuestion.options.map((option, optIdx) => {
                const isSelected = isOptionSelected(activeQuestionIdx, option.label, activeQuestion.multiSelect);

                return (
                  <button
                    key={optIdx}
                    type="button"
                    disabled={disabled}
                    onClick={() => handleOptionClick(activeQuestionIdx, option.label, activeQuestion.multiSelect)}
                    className={cn(
                      "w-full text-left p-3 rounded-lg border transition-colors",
                      "hover:border-gray-300",
                      isSelected
                        ? "border-blue-500 border-2 bg-blue-50"
                        : "border-gray-200",
                      disabled && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <div className="flex items-start gap-3">
                      {/* Radio/Checkbox indicator */}
                      <div className="flex-shrink-0 mt-0.5">
                        {activeQuestion.multiSelect ? (
                          <div className={cn(
                            "w-4 h-4 rounded border flex items-center justify-center",
                            isSelected
                              ? "bg-blue-500 border-blue-500"
                              : "border-gray-300"
                          )}>
                            {isSelected && (
                              <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 12 12">
                                <path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z" />
                              </svg>
                            )}
                          </div>
                        ) : (
                          <div className={cn(
                            "w-4 h-4 rounded-full border flex items-center justify-center",
                            isSelected
                              ? "border-blue-500"
                              : "border-gray-300"
                          )}>
                            {isSelected && (
                              <div className="w-2 h-2 rounded-full bg-blue-500" />
                            )}
                          </div>
                        )}
                      </div>

                      {/* Label and description */}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900">{option.label}</div>
                        {option.description && (
                          <div className="text-sm text-gray-500 mt-0.5">{option.description}</div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}

              {/* Other option */}
              <div
                className={cn(
                  "w-full p-3 rounded-lg border transition-colors",
                  isOtherSelected(activeQuestionIdx, activeQuestion.multiSelect)
                    ? "border-blue-500 border-2 bg-blue-50"
                    : "border-gray-200",
                  disabled && "opacity-50"
                )}
              >
                <div className="flex items-start gap-3">
                  {/* Radio/Checkbox indicator */}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => handleOtherClick(activeQuestionIdx, activeQuestion.multiSelect)}
                    className="flex-shrink-0 mt-0.5"
                  >
                    {activeQuestion.multiSelect ? (
                      <div className={cn(
                        "w-4 h-4 rounded border flex items-center justify-center",
                        isOtherSelected(activeQuestionIdx, activeQuestion.multiSelect)
                          ? "bg-blue-500 border-blue-500"
                          : "border-gray-300"
                      )}>
                        {isOtherSelected(activeQuestionIdx, activeQuestion.multiSelect) && (
                          <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 12 12">
                            <path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z" />
                          </svg>
                        )}
                      </div>
                    ) : (
                      <div className={cn(
                        "w-4 h-4 rounded-full border flex items-center justify-center",
                        isOtherSelected(activeQuestionIdx, activeQuestion.multiSelect)
                          ? "border-blue-500"
                          : "border-gray-300"
                      )}>
                        {isOtherSelected(activeQuestionIdx, activeQuestion.multiSelect) && (
                          <div className="w-2 h-2 rounded-full bg-blue-500" />
                        )}
                      </div>
                    )}
                  </button>

                  {/* Other input */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">Other:</span>
                      <Input
                        value={otherInputs[`q${activeQuestionIdx}`] || ""}
                        onChange={(e) => handleOtherChange(activeQuestionIdx, e.target.value)}
                        onFocus={() => handleOtherClick(activeQuestionIdx, activeQuestion.multiSelect)}
                        placeholder="Type your answer..."
                        disabled={disabled}
                        className="flex-1 h-7 text-sm"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50">
          <Button
            variant="ghost"
            onClick={handleSkip}
            disabled={disabled}
          >
            Skip
          </Button>
          <div className="flex items-center gap-2">
            {showTabs && (
              <span className="text-sm text-gray-500">
                {activeQuestionIdx + 1} of {questions.length}
              </span>
            )}
            <Button
              onClick={handleNext}
              disabled={disabled || (!currentHasSelection && !skippedQuestions.has(activeQuestionIdx))}
            >
              {isLastQuestion ? "Submit" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
