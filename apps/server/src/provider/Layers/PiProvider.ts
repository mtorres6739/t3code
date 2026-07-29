/**
 * Pi provider snapshot + health probe.
 *
 * Models and thinking levels come only from Pi RPC discovery — never from a
 * static fallback catalog.
 *
 * @module provider/Layers/PiProvider
 */
import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { discoverPiModels, type PiDiscoveryResult } from "../pi/PiRpcClient.ts";
import type { PiModel, PiThinkingLevel } from "../pi/PiRpcTypes.ts";
import { piModelSlug } from "../pi/PiRpcTypes.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

function thinkingCapabilities(levels: ReadonlyArray<PiThinkingLevel>): ModelCapabilities {
  if (levels.length === 0) {
    return createModelCapabilities({ optionDescriptors: [] });
  }
  const defaultLevel =
    levels.find((level) => level === "medium") ??
    levels.find((level) => level === "high") ??
    levels[0]!;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: levels.map((level) => ({
          id: level,
          label: level.charAt(0).toUpperCase() + level.slice(1),
          ...(level === defaultLevel ? { isDefault: true } : {}),
        })),
        currentValue: defaultLevel,
      },
    ],
  });
}

export function piModelToServerProviderModel(
  model: PiModel,
  levels: ReadonlyArray<PiThinkingLevel>,
  isDefault = false,
): ServerProviderModel {
  const slug = piModelSlug(model);
  const name = model.name?.trim() || slug;
  return {
    slug,
    name,
    isCustom: false,
    ...(isDefault ? { isDefault: true } : {}),
    ...(model.provider ? { subProvider: model.provider } : {}),
    capabilities: thinkingCapabilities(levels),
  };
}

export function buildPiDiscoveredModels(
  discovery: PiDiscoveryResult,
): ReadonlyArray<ServerProviderModel> {
  const currentSlug = discovery.currentModel ? piModelSlug(discovery.currentModel) : undefined;
  return discovery.models.map((model) => {
    const slug = piModelSlug(model);
    return piModelToServerProviderModel(
      model,
      discovery.thinkingLevelsBySlug.get(slug) ?? [],
      slug === currentSlug,
    );
  });
}

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    // No static catalog — empty until the health probe finishes discovery.
    const models = providerModelsFromSettings(
      [],
      piSettings.customModels ?? [],
      createModelCapabilities({ optionDescriptors: [] }),
    );

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI availability...",
      },
    });
  });
}

const runPiVersionCommand = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customOnlyModels = providerModelsFromSettings(
    [],
    piSettings.customModels ?? [],
    createModelCapabilities({ optionDescriptors: [] }),
  );

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: customOnlyModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    const missing = isCommandMissingCause(error);
    yield* Effect.logWarning("Pi CLI health check failed.", {
      errorTag: missing ? "not_found" : "error",
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: customOnlyModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `Pi binary not found (${piSettings.binaryPath || "pi"}). Install Pi or set the binary path.`
          : `Pi health check failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  }

  const versionOption = versionResult.success;
  if (versionOption._tag === "None") {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: customOnlyModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi --version timed out.",
      },
    });
  }

  const versionOutput = versionOption.value;
  const version =
    parseGenericCliVersion(versionOutput.stdout) ??
    parseGenericCliVersion(versionOutput.stderr) ??
    (versionOutput.stdout.trim() || versionOutput.stderr.trim() || null);

  if (versionOutput.code !== 0 && !version) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: customOnlyModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          versionOutput.stderr.trim() ||
          versionOutput.stdout.trim() ||
          `Pi --version exited with code ${versionOutput.code}.`,
      },
    });
  }

  const discoveryResult = yield* Effect.scoped(
    discoverPiModels({
      binaryPath: piSettings.binaryPath || "pi",
      env: environment,
    }),
  ).pipe(Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(discoveryResult) || discoveryResult.success._tag === "None") {
    const detail = Result.isFailure(discoveryResult)
      ? discoveryResult.failure.detail
      : "Pi model discovery timed out.";
    yield* Effect.logWarning("Pi model discovery failed.", { detail });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      // Critical: no static fake models on discovery failure.
      models: customOnlyModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi is installed but model discovery failed: ${detail}`,
      },
    });
  }

  const discovery = discoveryResult.success.value;
  const discoveredModels = buildPiDiscoveredModels(discovery);
  const models = providerModelsFromSettings(
    discoveredModels,
    piSettings.customModels ?? [],
    createModelCapabilities({ optionDescriptors: [] }),
  );

  if (discoveredModels.length === 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "Pi is installed but reported no models. Configure Pi providers/credentials, then refresh.",
      },
    });
  }

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
      message: `Pi ${version ?? "unknown"} — ${discoveredModels.length} model${discoveredModels.length === 1 ? "" : "s"} discovered.`,
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
