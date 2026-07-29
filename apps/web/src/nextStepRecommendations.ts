import type { ChatMessage } from "./types";

export interface NextStepRecommendation {
  readonly label: string;
  readonly prompt: string;
}

const MAX_RECOMMENDATIONS = 4;
const NEXT_STEPS_HEADING = /^#{1,6}\s*(?:recommended\s+)?next\s+steps?\s*:?[\s]*$/i;
const LIST_ITEM = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/;

function compactLabel(value: string): string {
  const normalized = value
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
  if (normalized.length <= 52) return normalized;
  return `${normalized.slice(0, 49).trimEnd()}...`;
}

function promptFromStep(step: string): string {
  const trimmed = step.trim();
  if (
    /^(?:please\s+)?(?:implement|run|review|fix|continue|create|update|commit|deploy|verify|investigate|add|remove|test|check)\b/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return `Proceed with this next step: ${trimmed}`;
}

export function extractExplicitNextSteps(text: string): NextStepRecommendation[] {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => NEXT_STEPS_HEADING.test(line.trim()));
  if (headingIndex < 0) return [];

  const steps: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#{1,6}\s+/.test(line.trim())) break;
    const match = LIST_ITEM.exec(line);
    if (!match?.[1]) {
      if (steps.length > 0 && line.trim().length > 0) break;
      continue;
    }
    const step = match[1].trim();
    if (!step) continue;
    steps.push(step);
    if (steps.length >= MAX_RECOMMENDATIONS) break;
  }

  return steps.map((step) => ({
    label: compactLabel(step),
    prompt: promptFromStep(step),
  }));
}

export function deriveNextStepRecommendations(
  assistantText: string | null | undefined,
): NextStepRecommendation[] {
  const text = assistantText?.trim();
  if (!text) return [];

  const explicit = extractExplicitNextSteps(text);
  if (explicit.length > 0) return explicit;

  if (
    /\b(blocked|blocker|cannot continue|need (?:your|user) (?:input|access|approval)|missing (?:access|credential|permission))\b/i.test(
      text,
    )
  ) {
    return [
      {
        label: "Resolve the blocker",
        prompt: "Resolve the blocker using the safest available workaround, then continue.",
      },
      {
        label: "Show what you need",
        prompt: "Show me the exact action, access, or decision you need from me to continue.",
      },
      {
        label: "Try another approach",
        prompt: "Try a different viable approach and report any remaining blocker.",
      },
    ];
  }

  if (
    /\b(test(?:s|ing)? failed|failing test|build failed|typecheck failed|lint failed|remaining (?:error|failure)s?)\b/i.test(
      text,
    )
  ) {
    return [
      {
        label: "Fix remaining failures",
        prompt: "Diagnose and fix the remaining failures, then rerun the focused checks.",
      },
      {
        label: "Explain the root cause",
        prompt: "Explain the root cause of the failures and the smallest safe fix.",
      },
      {
        label: "Review for regressions",
        prompt: "Review the latest changes for regressions before making any additional edits.",
      },
    ];
  }

  if (
    /\b(implemented|fixed|completed|shipped|tests? pass(?:ed|ing)?|verified|ready for review)\b/i.test(
      text,
    )
  ) {
    return [
      {
        label: "Review the changes",
        prompt:
          "Review the changes for bugs, regressions, and missed edge cases. Fix anything you find.",
      },
      {
        label: "Run focused checks",
        prompt: "Run the relevant focused tests and diagnostics, then fix any failures.",
      },
      {
        label: "Commit and push",
        prompt: "Commit and push the verified changes with a concise commit message.",
      },
    ];
  }

  if (/\b(plan|audit|recommendation|proposal|options?|approach)\b/i.test(text)) {
    return [
      {
        label: "Implement the top recommendation",
        prompt: "Implement the highest-impact recommendation now and verify it.",
      },
      {
        label: "Make a concrete plan",
        prompt:
          "Turn this into a concrete implementation plan with ordered steps and acceptance criteria.",
      },
      {
        label: "Prioritize by impact",
        prompt: "Prioritize the options by impact, risk, and effort, then recommend one.",
      },
    ];
  }

  return [
    {
      label: "Continue",
      prompt: "Continue with the next logical step and verify the result.",
    },
    {
      label: "Verify the result",
      prompt: "Verify the result with the relevant focused checks and fix any issues.",
    },
    {
      label: "Summarize remaining work",
      prompt: "Summarize what is complete, what remains, and the recommended next action.",
    },
  ];
}

export function latestCompletedAssistantText(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "text" | "streaming">>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") return null;
    if (message.role !== "assistant") continue;
    if (message.streaming || !message.text.trim()) return null;
    return message.text;
  }
  return null;
}
