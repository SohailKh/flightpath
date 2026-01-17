import { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { uploadUserInputFile, submitUserInput } from "../lib/api";
import type {
  AskUserInputRequest,
  UserInputField,
  UserInputFieldResponse,
  UserInputFileRef,
  SecretInputField,
  FileInputField,
  TextInputField,
  BooleanInputField,
} from "../types";
import { Button } from "./ui/button";

interface UserInputModalProps {
  pipelineId: string;
  request: AskUserInputRequest;
  onClose: () => void;
  onSubmitted: () => void;
}

interface FieldState {
  value: string;
  booleanValue: boolean;
  fileRef: UserInputFileRef | null;
  error: string | null;
  uploading: boolean;
}

export function UserInputModal({
  pipelineId,
  request,
  onClose,
  onSubmitted,
}: UserInputModalProps) {
  const [fieldStates, setFieldStates] = useState<Record<string, FieldState>>(
    {}
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Initialize field states
  useEffect(() => {
    const initialStates: Record<string, FieldState> = {};
    for (const field of request.fields) {
      initialStates[field.id] = {
        value: "",
        booleanValue: false,
        fileRef: null,
        error: null,
        uploading: false,
      };
    }
    setFieldStates(initialStates);
  }, [request.fields]);

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

  const updateField = useCallback(
    (fieldId: string, updates: Partial<FieldState>) => {
      setFieldStates((prev) => ({
        ...prev,
        [fieldId]: { ...prev[fieldId], ...updates },
      }));
    },
    []
  );

  const handleFileUpload = useCallback(
    async (field: FileInputField, file: File) => {
      updateField(field.id, { uploading: true, error: null });

      try {
        const result = await uploadUserInputFile(pipelineId, field.id, file);
        updateField(field.id, {
          uploading: false,
          fileRef: result.fileRef,
          error: null,
        });
      } catch (err) {
        updateField(field.id, {
          uploading: false,
          error: err instanceof Error ? err.message : "Upload failed",
        });
      }
    },
    [pipelineId, updateField]
  );

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);

    // Build field responses
    const responses: UserInputFieldResponse[] = [];

    for (const field of request.fields) {
      const state = fieldStates[field.id];
      if (!state) continue;

      const response: UserInputFieldResponse = {
        fieldId: field.id,
      };

      switch (field.type) {
        case "text":
        case "secret":
          if (state.value.trim()) {
            response.value = state.value;
          } else if (!field.required) {
            response.skipped = true;
          }
          break;
        case "file":
          if (state.fileRef) {
            response.fileRef = state.fileRef;
          } else if (!field.required) {
            response.skipped = true;
          }
          break;
        case "boolean":
          response.booleanValue = state.booleanValue;
          break;
      }

      responses.push(response);
    }

    try {
      await submitUserInput(pipelineId, request.id, responses);
      onSubmitted();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }, [pipelineId, request, fieldStates, onSubmitted]);

  // Check if form is valid (all required fields filled)
  const isValid = request.fields.every((field) => {
    const state = fieldStates[field.id];
    if (!state || !field.required) return true;

    switch (field.type) {
      case "text":
      case "secret":
        return state.value.trim() !== "";
      case "file":
        return state.fileRef !== null;
      case "boolean":
        return true; // boolean always has a value
    }
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {request.header}
            </h2>
            {request.description && (
              <p className="text-sm text-gray-500 mt-1">
                {request.description}
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {request.fields.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              state={fieldStates[field.id]}
              onValueChange={(value) => updateField(field.id, { value })}
              onBooleanChange={(booleanValue) =>
                updateField(field.id, { booleanValue })
              }
              onFileSelect={(file) =>
                handleFileUpload(field as FileInputField, file)
              }
              onClearFile={() => updateField(field.id, { fileRef: null })}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50">
          <div>
            {submitError && (
              <p className="text-sm text-red-600">{submitError}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!isValid || submitting}
            >
              {submitting ? "Submitting..." : "Submit"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface FieldInputProps {
  field: UserInputField;
  state: FieldState | undefined;
  onValueChange: (value: string) => void;
  onBooleanChange: (value: boolean) => void;
  onFileSelect: (file: File) => void;
  onClearFile: () => void;
}

function FieldInput({
  field,
  state,
  onValueChange,
  onBooleanChange,
  onFileSelect,
  onClearFile,
}: FieldInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!state) return null;

  const renderLabel = () => (
    <label className="block text-sm font-medium text-gray-700 mb-1">
      {field.label}
      {field.required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );

  const renderDescription = () =>
    field.description && (
      <p className="text-xs text-gray-500 mt-1">{field.description}</p>
    );

  const renderError = () =>
    state.error && <p className="text-xs text-red-600 mt-1">{state.error}</p>;

  switch (field.type) {
    case "secret": {
      const secretField = field as SecretInputField;
      return (
        <div>
          {renderLabel()}
          <div className="relative">
            <input
              type="password"
              value={state.value}
              onChange={(e) => onValueChange(e.target.value)}
              placeholder={secretField.formatHint || "Enter secret value..."}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">
                {secretField.envVarName}
              </span>
            </div>
          </div>
          {renderDescription()}
          {renderError()}
        </div>
      );
    }

    case "text": {
      const textField = field as TextInputField;
      return (
        <div>
          {renderLabel()}
          <input
            type="text"
            value={state.value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={textField.placeholder || "Enter value..."}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          />
          {renderDescription()}
          {renderError()}
        </div>
      );
    }

    case "file": {
      const fileField = field as FileInputField;
      const acceptStr = fileField.accept?.join(",") || "*/*";

      return (
        <div>
          {renderLabel()}
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptStr}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFileSelect(file);
            }}
            className="hidden"
          />

          {state.fileRef ? (
            <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-md">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-green-600"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {state.fileRef.filename}
                </p>
                <p className="text-xs text-gray-500">
                  {formatFileSize(state.fileRef.sizeBytes)}
                </p>
              </div>
              <button
                onClick={onClearFile}
                className="text-gray-400 hover:text-gray-600"
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
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ) : (
            <div
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-md cursor-pointer transition-colors",
                state.uploading
                  ? "border-blue-300 bg-blue-50"
                  : "border-gray-300 hover:border-blue-400 hover:bg-gray-50"
              )}
            >
              {state.uploading ? (
                <>
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-600 border-t-transparent mb-2" />
                  <p className="text-sm text-blue-600">Uploading...</p>
                </>
              ) : (
                <>
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
                    className="text-gray-400 mb-2"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p className="text-sm text-gray-600">
                    Click to upload or drag and drop
                  </p>
                  {fileField.accept && fileField.accept.length > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      {fileField.accept.join(", ")}
                    </p>
                  )}
                  {fileField.maxSizeBytes && (
                    <p className="text-xs text-gray-400">
                      Max: {formatFileSize(fileField.maxSizeBytes)}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {renderDescription()}
          {renderError()}
        </div>
      );
    }

    case "boolean": {
      const boolField = field as BooleanInputField;
      const trueLabel = boolField.trueLabel || "Yes";
      const falseLabel = boolField.falseLabel || "No";

      return (
        <div>
          {renderLabel()}
          <div className="flex gap-2">
            <button
              onClick={() => onBooleanChange(true)}
              className={cn(
                "flex-1 px-4 py-2 text-sm font-medium rounded-md border transition-colors",
                state.booleanValue
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              )}
            >
              {trueLabel}
            </button>
            <button
              onClick={() => onBooleanChange(false)}
              className={cn(
                "flex-1 px-4 py-2 text-sm font-medium rounded-md border transition-colors",
                !state.booleanValue
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              )}
            >
              {falseLabel}
            </button>
          </div>
          {renderDescription()}
          {renderError()}
        </div>
      );
    }
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
