export const executeReleaseGithub = async ({
  loadEnv,
  ensureMainBranch,
  resolveVersion,
  ensureRemoteTagExists,
  readVersion,
  runGithubRelease,
  runReleaseIt,
  argv,
}: {
  loadEnv: () => void
  ensureMainBranch: () => void
  resolveVersion: (argv: string[]) => string
  ensureRemoteTagExists: (version: string) => void
  readVersion: () => string
  runGithubRelease: (version: string) => Promise<void>
  runReleaseIt: () => Promise<void>
  argv: string[]
}) => {
  loadEnv()
  ensureMainBranch()
  const version = resolveVersion(argv)
  ensureRemoteTagExists(version)

  const packageVersion = readVersion()
  if (version !== packageVersion) {
    await runGithubRelease(version)
    return
  }

  await runReleaseIt()
}
