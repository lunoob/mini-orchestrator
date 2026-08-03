export const executeRelease = async ({
  prepare,
  publish,
  finalizeGit,
  releaseGithub,
}: {
  prepare: () => Promise<string>
  publish: () => Promise<void>
  finalizeGit: (version: string) => Promise<void>
  releaseGithub: (version: string) => Promise<void>
}) => {
  const version = await prepare()
  await publish()
  await finalizeGit(version)
  await releaseGithub(version)
}
