import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { PiSettings } from "@t3tools/contracts";

import {
  buildInitialPiProviderSnapshot,
  buildPiDiscoveredModels,
  checkPiProviderStatus,
  piModelToServerProviderModel,
} from "./PiProvider.ts";
import type { PiDiscoveryResult } from "../pi/PiRpcClient.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({ enabled: false }));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.models).toEqual([]);
    }),
  );

  it.effect("returns a pending snapshot with no static catalog by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.models).toEqual([]);
      expect(snapshot.message).toContain("Checking Pi");
    }),
  );
});

describe("Pi model discovery mapping", () => {
  it("maps discovered models with thinking levels only from RPC data", () => {
    const discovery: PiDiscoveryResult = {
      models: [
        { id: "claude-sonnet", provider: "anthropic", name: "Sonnet", reasoning: true },
        { id: "gpt", provider: "openai", reasoning: false },
      ],
      thinkingLevelsBySlug: new Map([
        ["anthropic/claude-sonnet", ["off", "low", "medium", "high"]],
        ["openai/gpt", ["off"]],
      ]),
      currentModel: { id: "claude-sonnet", provider: "anthropic" },
      currentThinkingLevels: ["off", "low", "medium", "high"],
    };
    const models = buildPiDiscoveredModels(discovery);
    expect(models.map((model) => model.slug)).toEqual(["anthropic/claude-sonnet", "openai/gpt"]);
    const sonnet = models[0]!;
    expect(sonnet.isDefault).toBe(true);
    expect(models[1]?.isDefault).not.toBe(true);
    const thinking = (sonnet.capabilities?.optionDescriptors ?? []).find(
      (descriptor) => descriptor.id === "thinking",
    );
    expect(thinking?.type).toBe("select");
    if (thinking?.type === "select") {
      expect(thinking.options.map((option) => option.id)).toEqual(["off", "low", "medium", "high"]);
    }
  });

  it("exposes empty thinking options when RPC returned none", () => {
    const model = piModelToServerProviderModel({ id: "x", provider: "p", name: "X" }, []);
    expect(model.capabilities?.optionDescriptors).toEqual([]);
  });
});

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("reports missing binary without inventing models", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/pi-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.models).toEqual([]);
      expect(snapshot.message).toMatch(/not found|failed/i);
    }),
  );

  it.effect("reports disabled settings without probing the binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({
          enabled: false,
          binaryPath: "/definitely/not/installed/pi-binary",
        }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("uses the configured binary path for version probe", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-version-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(
            piPath,
            ["#!/bin/sh", 'printf "pi 9.9.9\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(piPath, 0o755);

          // Version succeeds but model discovery (rpc) fails — no fake models.
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toContain("9.9.9");
      expect(snapshot.models).toEqual([]);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/model discovery failed/i);
    }),
  );
});
