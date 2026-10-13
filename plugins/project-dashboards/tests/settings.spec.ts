import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { BUILTIN_STATUS_TONES, DEFAULT_SETTINGS, INSTANCE_CONFIG_SCHEMA, normalizeSettings } from "../src/settings.js";

describe("settings", () => {
  it("returns documented defaults for empty or garbage config", () => {
    for (const raw of [undefined, null, {}, "x", []]) {
      expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
    expect(DEFAULT_SETTINGS).toMatchObject({
      locale: "en-US",
      currency: "USD",
      maxRevisions: 20,
      maxSpecBytes: 524288,
      navLabel: "Dashboards",
      projectTabLabel: "Dashboard",
    });
  });

  it("accepts valid overrides and canonicalizes locale and currency", () => {
    const settings = normalizeSettings({
      locale: "pt-br",
      currency: "brl",
      maxRevisions: 5,
      maxSpecBytes: 4096,
      navLabel: "  Painéis ",
      projectTabLabel: "Painel",
      palette: ["#112233", "#abc"],
      defaultStatusTones: { "In Review": "info", Shipped: "ok" },
    });
    expect(settings).toMatchObject({
      locale: "pt-BR",
      currency: "BRL",
      maxRevisions: 5,
      maxSpecBytes: 4096,
      navLabel: "Painéis",
      projectTabLabel: "Painel",
      palette: ["#112233", "#abc"],
    });
    expect(settings.defaultStatusTones).toEqual({ in_review: "info", shipped: "ok" });
  });

  it("falls back per field for invalid values and clamps numeric bounds", () => {
    const settings = normalizeSettings({
      locale: "not a locale!!",
      currency: "XX",
      maxRevisions: 0,
      maxSpecBytes: 10,
      navLabel: "",
      projectTabLabel: "x".repeat(60),
      defaultStatusTones: { a: "purple", b: "bad" },
    });
    expect(settings.locale).toBe("en-US");
    expect(settings.currency).toBe("USD");
    expect(settings.maxRevisions).toBe(1);
    expect(settings.maxSpecBytes).toBe(1024);
    expect(settings.navLabel).toBe("Dashboards");
    expect(settings.projectTabLabel).toBe("Dashboard");
    expect(settings.defaultStatusTones).toEqual({ b: "bad" });
    expect(normalizeSettings({ maxRevisions: 5000 }).maxRevisions).toBe(200);
    expect(normalizeSettings({ maxSpecBytes: 1e12 }).maxSpecBytes).toBe(8 * 1024 * 1024);
    expect(normalizeSettings({ maxRevisions: 2.5 }).maxRevisions).toBe(20);
  });

  it("keeps palette slots, blanking invalid entries and capping at 8", () => {
    expect(normalizeSettings({ palette: ["#fff", "red", 3, "#123456"] }).palette).toEqual(["#fff", "", "", "#123456"]);
    expect(normalizeSettings({ palette: ["red", "blue"] }).palette).toEqual([]);
    expect(normalizeSettings({ palette: Array.from({ length: 12 }, () => "#000") }).palette).toHaveLength(8);
  });

  it("ships built-in tones for English and Portuguese status values", () => {
    for (const [value, tone] of Object.entries({
      done: "ok", complete: "ok", ok: "ok", pronto: "ok",
      in_progress: "warn", partial: "warn", parcial: "warn",
      blocked: "bad", failed: "bad", falhou: "bad",
      todo: "muted", pending: "muted", pendente: "muted",
      p0: "bad", p1: "warn", p2: "muted",
    })) {
      expect(BUILTIN_STATUS_TONES[value], value).toBe(tone);
    }
  });

  it("declares the settings schema in the manifest", () => {
    expect(manifest.instanceConfigSchema).toBe(INSTANCE_CONFIG_SCHEMA);
    expect(Object.keys(INSTANCE_CONFIG_SCHEMA.properties).sort()).toEqual(
      ["currency", "defaultStaleAfterHours", "defaultStatusTones", "locale", "maxRevisions", "maxSpecBytes", "navLabel", "palette", "projectTabLabel", "refreshIntervalSeconds"].sort(),
    );
    expect(INSTANCE_CONFIG_SCHEMA.properties.maxRevisions).toMatchObject({ minimum: 1, maximum: 200, default: 20 });
    expect(INSTANCE_CONFIG_SCHEMA.properties.maxSpecBytes.default).toBe(524288);
  });
});
