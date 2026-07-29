/**
 * Fork-only side-by-side desktop identity for T3 Code Pi.
 *
 * Official T3 Code uses:
 * - product: "T3 Code (Alpha)"
 * - bundle id: com.t3tools.t3code
 * - protocol: t3code://
 * - Electron userData: t3code
 * - T3 home: ~/.t3
 *
 * This fork must never collide with those paths or handlers.
 */

export const APP_PRODUCT_BASE_NAME = "T3 Code Pi";

/** Packaged product name used by electron-builder and production display. */
export const APP_PRODUCT_NAME = APP_PRODUCT_BASE_NAME;

/** Development dock/window label. */
export const APP_PRODUCT_NAME_DEV = `${APP_PRODUCT_BASE_NAME} (Dev)`;

/** Nightly product label when a nightly channel build is produced. */
export const APP_PRODUCT_NAME_NIGHTLY = `${APP_PRODUCT_BASE_NAME} (Nightly)`;

/** macOS / Windows application id (CFBundleIdentifier / appUserModelId). */
export const APP_BUNDLE_ID = "com.mathewtorres.t3code.pi";

/** Development app user model / bundle id base before worktree suffix. */
export const APP_BUNDLE_ID_DEV = "com.mathewtorres.t3code.pi.dev";

/** Custom protocol schemes (without `://`). */
export const APP_PROTOCOL_SCHEME = "t3code-pi";
export const APP_PROTOCOL_SCHEME_DEV = "t3code-pi-dev";

/** Electron userData directory names under Application Support / AppData. */
export const APP_USER_DATA_DIR_NAME = "t3code-pi";
export const APP_USER_DATA_DIR_NAME_DEV = "t3code-pi-dev";

/**
 * Legacy Electron userData directory names (display-name based). Used only to
 * continue using an existing fork profile if present; never points at official
 * "T3 Code (Alpha)" / "t3code".
 */
export const APP_LEGACY_USER_DATA_DIR_NAME = APP_PRODUCT_NAME;
export const APP_LEGACY_USER_DATA_DIR_NAME_DEV = APP_PRODUCT_NAME_DEV;

/** Default T3 home directory name under the user home (`~/.t3-pi`). */
export const APP_DEFAULT_HOME_DIR_NAME = ".t3-pi";

/** Linux desktop identity. */
export const APP_LINUX_EXECUTABLE_NAME = "t3code-pi";
export const APP_LINUX_WM_CLASS = "t3code-pi";
export const APP_LINUX_WM_CLASS_DEV = "t3code-pi-dev";
export const APP_LINUX_DESKTOP_ENTRY_NAME = "t3code-pi.desktop";
export const APP_LINUX_DESKTOP_ENTRY_NAME_DEV = "t3code-pi-dev.desktop";

/** electron-builder artifact name template. */
export const APP_ARTIFACT_NAME_TEMPLATE = "T3-Code-Pi-${version}-${arch}.${ext}";

/**
 * Auto-updates stay off unless a fork-owned feed is configured explicitly via
 * `T3CODE_DESKTOP_UPDATE_REPOSITORY` (or mock update server). Ambient
 * `GITHUB_REPOSITORY` alone must not enable official/upstream feeds.
 */
export const APP_AUTO_UPDATE_REQUIRES_EXPLICIT_FEED = true;

export function resolveAppDisplayName(input) {
  if (input.isDevelopment) {
    return APP_PRODUCT_NAME_DEV;
  }
  if (input.isNightly) {
    return APP_PRODUCT_NAME_NIGHTLY;
  }
  return APP_PRODUCT_NAME;
}

export function resolveAppProtocolScheme(isDevelopment) {
  return isDevelopment ? APP_PROTOCOL_SCHEME_DEV : APP_PROTOCOL_SCHEME;
}

export function resolveAppBundleId(isDevelopment) {
  return isDevelopment ? APP_BUNDLE_ID_DEV : APP_BUNDLE_ID;
}

export function resolveAppUserDataDirName(isDevelopment) {
  return isDevelopment ? APP_USER_DATA_DIR_NAME_DEV : APP_USER_DATA_DIR_NAME;
}

export function resolveAppLegacyUserDataDirName(isDevelopment) {
  return isDevelopment ? APP_LEGACY_USER_DATA_DIR_NAME_DEV : APP_LEGACY_USER_DATA_DIR_NAME;
}

export function resolveAppLinuxWmClass(isDevelopment) {
  return isDevelopment ? APP_LINUX_WM_CLASS_DEV : APP_LINUX_WM_CLASS;
}

export function resolveAppLinuxDesktopEntryName(isDevelopment) {
  return isDevelopment ? APP_LINUX_DESKTOP_ENTRY_NAME_DEV : APP_LINUX_DESKTOP_ENTRY_NAME;
}
