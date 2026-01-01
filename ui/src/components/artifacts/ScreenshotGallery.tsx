import { useState } from "react";
import type { ArtifactRef } from "../../types";
import { getArtifactUrl } from "../../lib/api";
import { ImageLightbox } from "./ImageLightbox";

interface ScreenshotGalleryProps {
  pipelineId: string;
  screenshots: ArtifactRef[];
}

export function ScreenshotGallery({
  pipelineId,
  screenshots,
}: ScreenshotGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  if (screenshots.length === 0) {
    return null;
  }

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        {screenshots.map((screenshot, index) => (
          <button
            key={screenshot.id}
            onClick={() => setSelectedIndex(index)}
            className="relative aspect-video bg-gray-100 rounded overflow-hidden hover:ring-2 hover:ring-blue-400 transition-all group"
          >
            <img
              src={getArtifactUrl(pipelineId, screenshot.id)}
              alt={`Screenshot ${index + 1}`}
              className="w-full h-full object-cover"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent p-1">
              <span className="text-[10px] text-white truncate block">
                {new Date(screenshot.createdAt).toLocaleTimeString()}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Lightbox */}
      {selectedIndex !== null && (
        <ImageLightbox
          pipelineId={pipelineId}
          artifacts={screenshots}
          currentIndex={selectedIndex}
          onClose={() => setSelectedIndex(null)}
          onNavigate={setSelectedIndex}
        />
      )}
    </>
  );
}
