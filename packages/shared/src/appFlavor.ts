/**
 * Typed re-export of the fork desktop identity constants.
 * Implementation lives in `appFlavorRuntime.mjs` so plain Node launchers can share it.
 */

export {
  APP_ARTIFACT_NAME_TEMPLATE,
  APP_AUTO_UPDATE_REQUIRES_EXPLICIT_FEED,
  APP_BUNDLE_ID,
  APP_BUNDLE_ID_DEV,
  APP_DEFAULT_HOME_DIR_NAME,
  APP_LEGACY_USER_DATA_DIR_NAME,
  APP_LEGACY_USER_DATA_DIR_NAME_DEV,
  APP_LINUX_DESKTOP_ENTRY_NAME,
  APP_LINUX_DESKTOP_ENTRY_NAME_DEV,
  APP_LINUX_EXECUTABLE_NAME,
  APP_LINUX_WM_CLASS,
  APP_LINUX_WM_CLASS_DEV,
  APP_PRODUCT_BASE_NAME,
  APP_PRODUCT_NAME,
  APP_PRODUCT_NAME_DEV,
  APP_PRODUCT_NAME_NIGHTLY,
  APP_PROTOCOL_SCHEME,
  APP_PROTOCOL_SCHEME_DEV,
  APP_USER_DATA_DIR_NAME,
  APP_USER_DATA_DIR_NAME_DEV,
  resolveAppBundleId,
  resolveAppDisplayName,
  resolveAppLegacyUserDataDirName,
  resolveAppLinuxDesktopEntryName,
  resolveAppLinuxWmClass,
  resolveAppProtocolScheme,
  resolveAppUserDataDirName,
} from "./appFlavorRuntime.mjs";
