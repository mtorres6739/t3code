import { describe, expect, it } from "vite-plus/test";

import {
  deriveNextStepRecommendations,
  extractExplicitNextSteps,
  latestCompletedAssistantText,
} from "./nextStepRecommendations";

describe("next-step recommendations", () => {
  it("extracts explicit next steps before using fallbacks", () => {
    expect(
      extractExplicitNextSteps(
        `Done.\n\n## Next steps\n1. Run the focused tests.\n2. Deploy the preview.\n\n## Notes\nLater.`,
      ),
    ).toEqual([
      { label: "Run the focused tests", prompt: "Run the focused tests." },
      { label: "Deploy the preview", prompt: "Deploy the preview." },
    ]);
  });

  it("recommends recovery actions for a blocker", () => {
    const recommendations = deriveNextStepRecommendations(
      "I am blocked because the deployment credential is missing.",
    );
    expect(recommendations.map((item) => item.label)).toEqual([
      "Resolve the blocker",
      "Show what you need",
      "Try another approach",
    ]);
  });

  it("recommends verification and delivery after completed work", () => {
    const recommendations = deriveNextStepRecommendations(
      "Implemented the provider and all focused tests passed.",
    );
    expect(recommendations.map((item) => item.label)).toEqual([
      "Review the changes",
      "Run focused checks",
      "Commit and push",
    ]);
  });

  it("returns the latest settled assistant message only", () => {
    expect(
      latestCompletedAssistantText([
        { role: "user", text: "Fix it", streaming: false },
        { role: "assistant", text: "Fixed.", streaming: false },
      ]),
    ).toBe("Fixed.");

    expect(
      latestCompletedAssistantText([
        { role: "assistant", text: "Fixed.", streaming: false },
        { role: "user", text: "And test it", streaming: false },
      ]),
    ).toBeNull();

    expect(
      latestCompletedAssistantText([{ role: "assistant", text: "Still working", streaming: true }]),
    ).toBeNull();
  });
});
