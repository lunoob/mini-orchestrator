import path from "node:path"

import { config } from "dotenv"

export const loadReleaseEnv = (cwd = process.cwd()) => {
  config({ path: path.join(cwd, ".env"), quiet: true })

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    throw new Error("GITHUB_TOKEN is required. Set it in .env or the shell environment.")
  }

  return token
}
