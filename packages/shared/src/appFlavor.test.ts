import { describe, expect, it } from "vite-plus/test";

import {
  APP_AUTO_UPDATE_REQUIRES_EXPLICIT_FEED,
  APP_BUNDLE_ID,
  APP_BUNDLE_ID_DEV,
  APP_DEFAULT_HOME_DIR_NAME,
  APP_PRODUCT_NAME,
  APP_PRODUCT_NAME_DEV,
  APP_PROTOCOL_SCHEME,
  APP_PROTOCOL_SCHEME_DEV,
  APP_USER_DATA_DIR_NAME,
  APP_USER_DATA_DIR_NAME_DEV,
  resolveAppBundleId,
  resolveAppDisplayName,
  resolveAppProtocolScheme,
  resolveAppUserDataDirName,
} from "./appFlavor.ts";

describe("appFlavor", () => {
  it("uses fork-only identity that does not collide with official T3 Code", () => {
    expect(APP_PRODUCT_NAME).toBe("T3 Code Pi");
    expect(APP_PRODUCT_NAME_DEV).toBe("T3 Code Pi (Dev)");
    expect(APP_BUNDLE_ID).toBe("com.mathewtorres.t3code.pi");
    expect(APP_BUNDLE_ID_DEV).toBe("com.mathewtorres.t3code.pi.dev");
    expect(APP_PROTOCOL_SCHEME).toBe("t3code-pi");
    expect(APP_PROTOCOL_SCHEME_DEV).toBe("t3code-pi-dev");
    expect(APP_USER_DATA_DIR_NAME).toBe("t3code-pi");
    expect(APP_USER_DATA_DIR_NAME_DEV).toBe("t3code-pi-dev");
    expect(APP_DEFAULT_HOME_DIR_NAME).toBe(".t3-pi");
    expect(APP_AUTO_UPDATE_REQUIRES_EXPLICIT_FEED).toBe(true);

    // Official identity must never be reused.
    expect(APP_BUNDLE_ID).not.toBe("com.t3tools.t3code");
    expect(APP_PROTOCOL_SCHEME).not.toBe("t3code");
    expect(APP_USER_DATA_DIR_NAME).not.toBe("t3code");
    expect(APP_DEFAULT_HOME_DIR_NAME).not.toBe(".t3");
  });

  it("resolves display name, scheme, bundle id, and userData per mode", () => {
    expect(resolveAppDisplayName({ isDevelopment: false })).toBe("T3 Code Pi");
    expect(resolveAppDisplayName({ isDevelopment: true })).toBe("T3 Code Pi (Dev)");
    expect(resolveAppDisplayName({ isDevelopment: false, isNightly: true })).toBe(
      "T3 Code Pi (Nightly)",
    );
    expect(resolveAppProtocolScheme(false)).toBe("t3code-pi");
    expect(resolveAppProtocolScheme(true)).toBe("t3code-pi-dev");
    expect(resolveAppBundleId(false)).toBe("com.mathewtorres.t3code.pi");
    expect(resolveAppBundleId(true)).toBe("com.mathewtorres.t3code.pi.dev");
    expect(resolveAppUserDataDirName(false)).toBe("t3code-pi");
    expect(resolveAppUserDataDirName(true)).toBe("t3code-pi-dev");
  });
});
