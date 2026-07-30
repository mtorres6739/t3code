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
  mapPiCommandsToSlashCommands,
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
      commands: [],
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

describe("mapPiCommandsToSlashCommands", () => {
  it("maps names, descriptions, and argument hints for composer autocomplete", () => {
    expect(
      mapPiCommandsToSlashCommands([
        {
          name: "review",
          description: "Review changes",
          argumentHint: "[path]",
          source: "prompt",
        },
        { name: "skill:test", description: "Run skill", source: "skill" },
        { name: "llama", source: "extension" },
      ]),
    ).toEqual([
      {
        name: "review",
        description: "Review changes",
        input: { hint: "[path]" },
      },
      {
        name: "skill:test",
        description: "Run skill",
      },
      {
        name: "llama",
      },
    ]);
  });

  it("dedupes command names case-insensitively while filling missing fields", () => {
    expect(
      mapPiCommandsToSlashCommands([
        { name: "Review" },
        { name: "review", description: "Review changes", argumentHint: "[path]" },
        { name: "REVIEW", description: "ignored later", argumentHint: "ignored" },
      ]),
    ).toEqual([
      {
        name: "Review",
        description: "Review changes",
        input: { hint: "[path]" },
      },
    ]);
  });

  it("drops empty command names", () => {
    expect(mapPiCommandsToSlashCommands([{ name: "   " }, { name: "" }])).toEqual([]);
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

  it.effect("includes discovered slash commands on a ready snapshot", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-cmds-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(
            piPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("pi 1.2.3\\n");
  process.exit(0);
}
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const id = msg.id;
    const respond = (command, success, data, error) => {
      process.stdout.write(JSON.stringify({
        type: "response", id, command, success,
        ...(data !== undefined ? { data } : {}),
        ...(error ? { error } : {}),
      }) + "\\n");
    };
    switch (msg.type) {
      case "get_available_models":
        respond("get_available_models", true, {
          models: [{ id: "sonnet", provider: "anthropic", name: "Sonnet", reasoning: true }],
        });
        break;
      case "get_state":
        respond("get_state", true, {
          model: { id: "sonnet", provider: "anthropic" },
          thinkingLevel: "medium",
        });
        break;
      case "get_available_thinking_levels":
        respond("get_available_thinking_levels", true, { levels: ["off", "medium", "high"] });
        break;
      case "get_commands":
        respond("get_commands", true, {
          commands: [
            { name: "review", description: "Review changes", source: "prompt", argumentHint: "[path]" },
            { name: "skill:test", description: "Test skill", source: "skill" },
            { name: "llama", description: "Manage models", source: "extension" },
          ],
        });
        break;
      default:
        respond(msg.type || "unknown", false, undefined, "unknown command");
    }
  }
});
`,
          );
          yield* fs.chmod(piPath, 0o755);
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["anthropic/sonnet"]);
      expect(snapshot.slashCommands).toEqual([
        {
          name: "review",
          description: "Review changes",
          input: { hint: "[path]" },
        },
        {
          name: "skill:test",
          description: "Test skill",
        },
        {
          name: "llama",
          description: "Manage models",
        },
      ]);
    }),
  );

  it.effect("stays ready when get_commands fails but models succeed", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-cmdfail-" });
          const piPath = path.join(dir, "pi");
          yield* fs.writeFileString(
            piPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("pi 1.2.3\\n");
  process.exit(0);
}
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const id = msg.id;
    const respond = (command, success, data, error) => {
      process.stdout.write(JSON.stringify({
        type: "response", id, command, success,
        ...(data !== undefined ? { data } : {}),
        ...(error ? { error } : {}),
      }) + "\\n");
    };
    switch (msg.type) {
      case "get_available_models":
        respond("get_available_models", true, {
          models: [{ id: "m", provider: "p", name: "M", reasoning: false }],
        });
        break;
      case "get_state":
        respond("get_state", true, { model: { id: "m", provider: "p" } });
        break;
      case "get_available_thinking_levels":
        respond("get_available_thinking_levels", true, { levels: ["off"] });
        break;
      case "get_commands":
        respond("get_commands", false, undefined, "unknown command");
        break;
      default:
        respond(msg.type || "unknown", false, undefined, "unknown command");
    }
  }
});
`,
          );
          yield* fs.chmod(piPath, 0o755);
          return yield* checkPiProviderStatus(
            decodePiSettings({ enabled: true, binaryPath: piPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["p/m"]);
      expect(snapshot.slashCommands).toEqual([]);
    }),
  );
});
