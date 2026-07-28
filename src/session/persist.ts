import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import type { SessionStoreSnapshot } from "./store.js"

const SNAPSHOT_FILE = "sessions.json"

export const getSessionSnapshotPath = (runDirectory: string) =>
  path.join(runDirectory, SNAPSHOT_FILE)

export const writeSessionSnapshot = async (
  runDirectory: string,
  snapshot: SessionStoreSnapshot,
) => {
  await mkdir(runDirectory, { recursive: true })
  const filePath = getSessionSnapshotPath(runDirectory)
  const temporaryPath = `${filePath}.tmp`

  // Replace atomically so a process crash cannot leave resume with partial JSON.
  await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), "utf8")
  await rename(temporaryPath, filePath)
  return filePath
}

export const readSessionSnapshot = async (runDirectory: string): Promise<SessionStoreSnapshot | undefined> => {
  const filePath = getSessionSnapshotPath(runDirectory)
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as SessionStoreSnapshot
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}
