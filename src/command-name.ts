import path from "node:path"

export const COMMAND_NAME_ENV = "MINI_ORCH_COMMAND"

const DEFAULT_COMMAND_NAME = "mini-orch"
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const normalizeCommandName = (value: string | undefined) => {
  const name = value?.trim()
  return name && COMMAND_NAME_PATTERN.test(name) ? name : undefined
}

export const getCommandName = (
  entryPath = process.argv[1],
  envValue = process.env[COMMAND_NAME_ENV],
) => {
  const envName = normalizeCommandName(envValue)
  if (envName) return envName

  const entryName = entryPath
    ? normalizeCommandName(path.basename(entryPath, path.extname(entryPath)))
    : undefined

  return entryName === DEFAULT_COMMAND_NAME ? entryName : DEFAULT_COMMAND_NAME
}
