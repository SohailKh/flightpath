import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface MessageInputProps {
  onSubmit: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  buttonText?: string;
  defaultValue?: string;
}

export function MessageInput({
  onSubmit,
  disabled,
  placeholder = "Enter a message...",
  buttonText = "Run",
  defaultValue = "Describe the feature you want to build...",
}: MessageInputProps) {
  const [message, setMessage] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && !disabled) {
      onSubmit(message.trim());
      setMessage("");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <Input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1"
        defaultValue={defaultValue}
        content={defaultValue}
        
      />
      <Button type="submit" disabled={disabled || !message.trim()}>
        {buttonText}
      </Button>
    </form>
  );
}
