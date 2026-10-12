import { afterEach, describe, expect, test } from "bun:test"

// `version.ts` resolves its exports at module-eval time. Import it through a
// unique query string per case so each evaluation observes a fresh environment.
async function loadVersionModule() {
  return import(`../src/installation/version.ts?case=${crypto.randomUUID()}`)
}

afterEach(() => {
  delete process.env.OPENCODE_APP_VERSION
})

describe("installation version", () => {
  test("falls back to \"local\" when no define was injected and no env override is set", async () => {
    const mod = await loadVersionModule()
    expect(mod.InstallationVersion).toBe("local")
  })

  test("OPENCODE_APP_VERSION overrides the missing build-time define", async () => {
    process.env.OPENCODE_APP_VERSION = "1.18.30"
    const mod = await loadVersionModule()
    expect(mod.InstallationVersion).toBe("1.18.30")
  })

  test("InstallationLocal stays consistent with the channel fallback", async () => {
    process.env.OPENCODE_APP_VERSION = "1.18.30"
    const mod = await loadVersionModule()
    expect(mod.InstallationLocal).toBe(true)
  })
})
