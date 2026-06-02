import { describe, it, expect } from "vitest";
import { formatUserProfile } from "../user-profile";
import type { UserProfile } from "../../types";

describe("formatUserProfile", () => {
  it("returns null when the profile is null/undefined", () => {
    expect(formatUserProfile(null)).toBeNull();
    expect(formatUserProfile(undefined)).toBeNull();
  });

  it("returns null when disabled, even if every field is filled", () => {
    const p: UserProfile = {
      enabled: false,
      name: "Alice",
      occupation: "Engineer",
      location: "Ohio",
      about: "Builds things",
      response_style: "Be terse",
    };
    expect(formatUserProfile(p)).toBeNull();
  });

  it("returns null when enabled but every field is blank", () => {
    expect(
      formatUserProfile({ enabled: true, name: "  ", about: "", response_style: null }),
    ).toBeNull();
  });

  it("renders only the fields that are present", () => {
    const out = formatUserProfile({ enabled: true, name: "Alice", occupation: "Engineer" });
    expect(out).toContain("- Name: Alice");
    expect(out).toContain("- Occupation: Engineer");
    expect(out).not.toContain("Location");
    expect(out).not.toContain("About them");
  });

  it("includes the response-style line when set", () => {
    const out = formatUserProfile({ enabled: true, response_style: "Be concise" });
    expect(out).toContain("How they want you to respond: Be concise");
  });

  it("trims and collapses whitespace in short fields", () => {
    const out = formatUserProfile({ enabled: true, name: "  Alice   D  " });
    expect(out).toContain("- Name: Alice D");
  });

  it("caps an over-long short field", () => {
    const out = formatUserProfile({ enabled: true, name: "x".repeat(500) });
    // 200-char cap; the rendered line is "- Name: " + 200 x's.
    expect(out).toContain(`- Name: ${"x".repeat(200)}`);
    expect(out).not.toContain("x".repeat(201));
  });

  it("frames the block as user-supplied context", () => {
    const out = formatUserProfile({ enabled: true, name: "Alice" });
    expect(out).toMatch(/do not repeat it back/i);
  });
});
