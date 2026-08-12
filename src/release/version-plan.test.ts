import { describe, expect, it } from "vitest"

import { isPrerelease, nextProductionVersion, nextStagingVersion } from "./version-plan.js"

describe("nextStagingVersion", () => {
  it("creates staging.0 from a production version", () => {
    expect(nextStagingVersion("0.2.0")).toBe("0.2.0-staging.0")
    expect(nextStagingVersion("0.1.7")).toBe("0.1.7-staging.0")
  })

  it("increments an existing staging version", () => {
    expect(nextStagingVersion("0.2.0-staging.0")).toBe("0.2.0-staging.1")
    expect(nextStagingVersion("0.2.0-staging.3")).toBe("0.2.0-staging.4")
  })

  it("restarts staging from another prerelease", () => {
    expect(nextStagingVersion("0.2.0-beta.1")).toBe("0.2.0-staging.0")
  })

  it("rejects invalid versions", () => {
    expect(() => nextStagingVersion("staging")).toThrow()
  })
})

describe("nextProductionVersion", () => {
  it("increments from a production base", () => {
    expect(nextProductionVersion("0.1.7", "patch")).toBe("0.1.8")
    expect(nextProductionVersion("0.1.7", "minor")).toBe("0.2.0")
    expect(nextProductionVersion("0.1.7", "major")).toBe("1.0.0")
  })
})

describe("isPrerelease", () => {
  it("detects prerelease versions", () => {
    expect(isPrerelease("0.2.0")).toBe(false)
    expect(isPrerelease("0.2.0-staging.0")).toBe(true)
    expect(isPrerelease("1.0.0-rc.1")).toBe(true)
  })
})
