import { appendFileSync } from "node:fs"
import { prerelease, valid } from "semver"

try {
  for (const name of ["GITHUB_OUTPUT", "GITHUB_ENV"]) {
    if (!process.env[name]) throw new Error(`${name} is not set`)
  }
  const raw = process.argv[2] ?? process.env.GITHUB_REF_NAME
  if (!raw) throw new Error("Release version is not set")

  const version = raw.startsWith("v") ? raw.slice(1) : raw
  if (!valid(version)) throw new Error(`Invalid semantic version: ${raw}`)

  const distTag = prerelease(version) ? "next" : "latest"
  appendFileSync(process.env.GITHUB_ENV, `VERSION=${version}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ndist-tag=${distTag}\n`)
  console.log(`Release version ${version} (dist-tag ${distTag})`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
