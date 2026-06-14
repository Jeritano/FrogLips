/**
 * Behavior-snapshot battery (security-manifest dedup, Step 0).
 *
 * Pins the CURRENT TS-side security catalogs so the manifest migration
 * (Steps 1-6) can be proven behavior-preserving:
 *   - the role-framing token catalog `untrusted-fence` strips (Step 4 unifies
 *     it with the Rust injection scanner via the manifest — ADDITIVE only), and
 *   - the `matchesPolicyPattern` glob matcher verdicts (Step 5 adds a
 *     cross-language parity fixture; the matcher itself stays twin code).
 *
 * Step 4 widens the stripped-token set (more caught, never fewer): the
 * "additive" assertions below check that EVERY token stripped today is still
 * stripped after the migration.
 */
import { describe, expect, it } from "vitest";
import { ROLE_FRAMING_TOKENS, stripRoleFraming } from "../untrusted-fence";
import { matchesPolicyPattern } from "../runner";
import { classifyToolRisk } from "../dispatch";
import policyFixture from "../../../../src-tauri/policy-matcher-fixture.json";

/** The exact token set the TS fence stripped at Step 0 (pre-manifest). Step 4
 *  may only ADD to the live catalog — every token here must still be neutered. */
const STEP0_ROLE_FRAMING_TOKENS = [
  "<|im_start|>",
  "<|im_end|>",
  "<|start_header_id|>",
  "<|end_header_id|>",
  "<|eot_id|>",
  "<|begin_of_text|>",
  "<|end_of_text|>",
  "<|system|>",
  "<|user|>",
  "<|assistant|>",
  "[INST]",
  "[/INST]",
  "<<SYS>>",
  "<</SYS>>",
  "<start_of_turn>",
  "<end_of_turn>",
  "<|end|>",
] as const;

describe("role-framing token catalog (snapshot, additive)", () => {
  it("still strips every Step-0 token (no regression)", () => {
    for (const tok of STEP0_ROLE_FRAMING_TOKENS) {
      const out = stripRoleFraming(`before ${tok} after`);
      expect(out).not.toContain(tok);
      expect(out).toContain("[stripped-role-token]");
    }
  });

  it("the live catalog is a SUPERSET of the Step-0 catalog", () => {
    for (const tok of STEP0_ROLE_FRAMING_TOKENS) {
      expect(ROLE_FRAMING_TOKENS as readonly string[]).toContain(tok);
    }
  });

  it("still strips stray untrusted-data fence tags", () => {
    expect(stripRoleFraming("x <untrusted-data> y </untrusted-data> z")).toBe(
      "x  y  z",
    );
  });
});

/* Policy-matcher fixture battery: (path, pattern) → verdict, loaded from the
 * SAME checked-in JSON the Rust twin parity test (policy.rs) reads, so the two
 * intentionally-twinned implementations cannot drift (Step 5). */
describe("matchesPolicyPattern fixture (cross-language parity)", () => {
  it("produces the pinned verdict for every fixture row", () => {
    for (const c of policyFixture.cases) {
      expect(matchesPolicyPattern(c.path, c.pattern)).toBe(c.expect);
    }
  });
});

/* Step 5: the write-confirmation risk badge (`classifyToolRisk`) now sources
 * its sensitive-path set from the manifest, so it fires on a SUPERSET of the
 * old hard-coded checks — additive, no gate weakened. */
describe("risk-badge sensitive-path superset (Step 5)", () => {
  const home = "/Users/tester";

  it("still escalates the paths the old hard-coded checks caught", async () => {
    for (const sub of [
      ".ssh/authorized_keys",
      ".aws/credentials",
      ".gnupg/secring.gpg",
      ".zshrc",
      "Library/LaunchAgents/x.plist",
    ]) {
      expect(
        await classifyToolRisk("write_file", { path: `${home}/${sub}` }),
      ).toBe("destructive");
    }
    // System dirs + bundle extensions (UX-only extras) still fire.
    expect(await classifyToolRisk("write_file", { path: "/etc/hosts" })).toBe(
      "destructive",
    );
    expect(
      await classifyToolRisk("write_file", { path: "/usr/local/bin/x" }),
    ).toBe("destructive");
    expect(
      await classifyToolRisk("write_file", { path: `${home}/Foo.app/x` }),
    ).toBe("destructive");
  });

  it("now ALSO escalates manifest paths the old checks missed (superset)", async () => {
    for (const sub of [
      ".docker/config.json",
      ".kube/config",
      ".pypirc",
      ".netrc",
      ".config/gh/hosts.yml",
      ".config/gcloud/creds.db",
      "Library/Application Support/Google/Chrome/Default/Cookies",
      "Library/Application Support/Firefox/profiles.ini",
      "Library/Cookies/Cookies.binarycookies",
      "Library/Application Support/Froglips/db.sqlite",
      ".local-llm-app/secrets.json",
    ]) {
      expect(
        await classifyToolRisk("write_file", { path: `${home}/${sub}` }),
      ).toBe("destructive");
    }
    // Credential basenames anywhere also escalate.
    expect(
      await classifyToolRisk("write_file", { path: `${home}/proj/.env.local` }),
    ).toBe("destructive");
    expect(
      await classifyToolRisk("write_file", {
        path: `${home}/proj/credentials.json`,
      }),
    ).toBe("destructive");
  });

  it("leaves ordinary workspace writes at normal risk", async () => {
    expect(
      await classifyToolRisk("write_file", {
        path: `${home}/projects/app/src/main.ts`,
      }),
    ).toBe("normal");
    // A prefix-sibling of a protected dir must NOT match (component-anchored).
    expect(
      await classifyToolRisk("write_file", {
        path: `${home}/.sshfoo/notes.txt`,
      }),
    ).toBe("normal");
  });
});
