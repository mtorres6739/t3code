/**
 * Pi text generation — stubbed in v1.
 *
 * Chat execution is the required Pi feature. Commit/PR/branch/title generation
 * can fall back to other providers until a Pi RPC path is wired.
 *
 * @module textGeneration/PiTextGeneration
 */
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TextGeneration from "./TextGeneration.ts";

const notSupported = (operation: string) =>
  new TextGenerationError({
    operation,
    detail: "Pi does not support text generation in this T3 Code build yet.",
  });

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* () {
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.fail(notSupported("generateCommitMessage")),
    generatePrContent: () => Effect.fail(notSupported("generatePrContent")),
    generateBranchName: () => Effect.fail(notSupported("generateBranchName")),
    generateThreadTitle: () => Effect.fail(notSupported("generateThreadTitle")),
  });
});
