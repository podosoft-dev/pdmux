const { devices } = require("@playwright/test");

/**
 * Mobile coverage is two engines, not two phones.
 *
 * The layout rules the `*.mobile.spec.ts` files pin are CSS-structural and break the
 * same way everywhere; what differs between phones is the engine (soft keyboard and
 * viewport, pull-to-refresh, back button). One Blink project stands in for Chrome, Edge
 * and Samsung Internet, and one WebKit project for every browser on iOS.
 *
 * WebKit is opt-in with `PDMUX_WEBKIT=1`: it needs its own download and about twenty
 * system libraries a plain server does not carry, and only the launch fails without
 * them, so presence of the binary cannot be probed.
 *
 * @type {NonNullable<import("@playwright/test").PlaywrightTestConfig["projects"]>}
 */
module.exports = [
  {
    name: "ui-mobile",
    testMatch: /.*\.mobile\.spec\.ts/,
    dependencies: ["setup"],
    use: { ...devices["Pixel 7"], storageState: "playwright/.auth/admin.json" },
  },
  ...(process.env.PDMUX_WEBKIT === "1"
    ? [
        {
          name: "ui-mobile-webkit",
          testMatch: /.*\.mobile\.spec\.ts/,
          dependencies: ["setup"],
          use: { ...devices["iPhone 14"], storageState: "playwright/.auth/admin.json" },
        },
      ]
    : []),
];
