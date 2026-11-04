import { describe, expect, it } from "vitest";
import { actionEffect } from "../../src/drivers/action-effect.js";

describe("actionEffect", () => {
  it("reports URL changes before title changes", () => {
    expect(actionEffect({ url: "https://a.test/", title: "A" }, { url: "https://a.test/next", title: "B" })).toBe("url_changed");
  });

  it("reports title-only changes", () => {
    expect(actionEffect({ url: "https://a.test/", title: "A" }, { url: "https://a.test/", title: "B" })).toBe("title_changed");
  });

  it("reports no visible change when both are stable", () => {
    expect(actionEffect({ url: "https://a.test/", title: "A" }, { url: "https://a.test/", title: "A" })).toBe("no_visible_change");
  });
});
