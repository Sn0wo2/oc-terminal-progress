import { appendFileSync } from "node:fs"
import { execaSync } from "execa"

try {
  for (const name of ["GITHUB_OUTPUT", "VERSION"]) {
    if (!process.env[name]) throw new Error(`${name} is not set`)
  }
  const packageDir = process.env.PACKAGE_DIR ?? "."
  const manifest = packageDir === "." ? "package.json" : `${packageDir}/package.json`

  execaSync("npm", ["pkg", "set", `version=${process.env.VERSION}`], { cwd: packageDir })
  execaSync("bun", ["install"])

  const changed = execaSync("git", ["diff", "--quiet", "--", manifest, "bun.lock"], { reject: false }).exitCode !== 0
  if (changed) appendFileSync(process.env.GITHUB_OUTPUT, "changed=true\n")
  console.log(
    changed ? `Package version synced to ${process.env.VERSION}.` : `Package version already ${process.env.VERSION}.`,
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
