import { memo } from "react";

import type { NextStepRecommendation } from "../../nextStepRecommendations";

interface NextStepRecommendationsProps {
  readonly recommendations: ReadonlyArray<NextStepRecommendation>;
  readonly disabled?: boolean;
  readonly onSelect: (prompt: string) => void;
}

export const NextStepRecommendations = memo(function NextStepRecommendations({
  recommendations,
  disabled = false,
  onSelect,
}: NextStepRecommendationsProps) {
  if (recommendations.length === 0) return null;

  return (
    <div
      aria-label="Recommended next steps"
      className="mx-auto flex w-full max-w-3xl items-center gap-2 overflow-x-auto px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <span className="shrink-0 pl-1 font-medium text-[11px] text-muted-foreground/80 uppercase tracking-[0.12em]">
        Next
      </span>
      {recommendations.map((recommendation) => (
        <button
          key={`${recommendation.label}:${recommendation.prompt}`}
          type="button"
          disabled={disabled}
          title={recommendation.prompt}
          onClick={() => onSelect(recommendation.prompt)}
          className="shrink-0 rounded-full border border-border/65 bg-card/90 px-3 py-1.5 text-foreground/85 text-xs shadow-sm backdrop-blur transition-colors hover:border-border hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {recommendation.label}
        </button>
      ))}
    </div>
  );
});
