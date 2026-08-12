import { describe, expect, it } from "vitest"

import {
  assertPackageJsonOnlyVersionChanged,
  assertPackageLockOnlyVersionChanged,
  packageJsonWithoutVersion,
  packageLockWithoutVersionFields,
} from "./version-files.js"

describe("version file field guards", () => {
  it("allows only package.json version changes", () => {
    expect(() =>
      assertPackageJsonOnlyVersionChanged(
        { name: "mini-orch", version: "0.9.0" },
        { name: "mini-orch", version: "1.0.0" },
      ),
    ).not.toThrow()
  })

  it("rejects other package.json field changes", () => {
    expect(() =>
      assertPackageJsonOnlyVersionChanged(
        { name: "mini-orch", version: "0.9.0", description: "old" },
        { name: "mini-orch", version: "1.0.0", description: "new" },
      ),
    ).toThrow("Release commit only allows package.json version field changes.")
  })

  it("allows only package-lock.json version changes", () => {
    expect(() =>
      assertPackageLockOnlyVersionChanged(
        { name: "mini-orch", version: "0.9.0", packages: { "": { version: "0.9.0" } } },
        { name: "mini-orch", version: "1.0.0", packages: { "": { version: "1.0.0" } } },
      ),
    ).not.toThrow()
  })

  it("rejects other package-lock.json field changes", () => {
    expect(() =>
      assertPackageLockOnlyVersionChanged(
        { name: "mini-orch", version: "0.9.0", lockfileVersion: 3 },
        { name: "mini-orch", version: "1.0.0", lockfileVersion: 2 },
      ),
    ).toThrow("Release commit only allows package-lock.json version field changes.")
  })

  it("strips only version fields from lockfiles", () => {
    expect(
      packageLockWithoutVersionFields({
        version: "1.0.0",
        packages: { "": { version: "1.0.0", license: "MIT" } },
      }),
    ).toEqual({
      packages: { "": { license: "MIT" } },
    })
    expect(packageJsonWithoutVersion({ name: "mini-orch", version: "1.0.0" })).toEqual({ name: "mini-orch" })
  })
})
