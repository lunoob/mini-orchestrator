export const packageJsonWithoutVersion = (value: Record<string, unknown>) => {
  const { version: _, ...rest } = value
  return rest
}

export const packageLockWithoutVersionFields = (value: Record<string, unknown>) => {
  const lock = structuredClone(value) as Record<string, unknown>
  delete lock.version

  const packages = lock.packages
  if (packages && typeof packages === "object") {
    const root = (packages as Record<string, Record<string, unknown>>)[""]
    if (root) delete root.version
  }

  return lock
}

export const assertPackageJsonOnlyVersionChanged = (
  head: Record<string, unknown>,
  work: Record<string, unknown>,
) => {
  if (JSON.stringify(packageJsonWithoutVersion(head)) !== JSON.stringify(packageJsonWithoutVersion(work))) {
    throw new Error("Release commit only allows package.json version field changes.")
  }
}

export const assertPackageLockOnlyVersionChanged = (
  head: Record<string, unknown>,
  work: Record<string, unknown>,
) => {
  if (
    JSON.stringify(packageLockWithoutVersionFields(head)) !==
    JSON.stringify(packageLockWithoutVersionFields(work))
  ) {
    throw new Error("Release commit only allows package-lock.json version field changes.")
  }
}
