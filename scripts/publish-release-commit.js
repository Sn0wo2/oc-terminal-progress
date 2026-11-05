import { appendFileSync } from "node:fs"
import { execaSync } from "execa"

try {
  for (const name of ["GITHUB_OUTPUT", "VERSION", "GH_TOKEN", "DEFAULT_BRANCH"]) {
    if (!process.env[name]) throw new Error(`${name} is not set`)
  }
  const version = process.env.VERSION
  const tag = `v${version}`
  const defaultBranch = process.env.DEFAULT_BRANCH
  const packageDir = process.env.PACKAGE_DIR ?? "."
  const manifest = packageDir === "." ? "package.json" : `${packageDir}/package.json`
  const push = (...command) => execaSync("git", ["-c", "credential.helper=!gh auth git-credential", "push", ...command])

  execaSync("git", ["config", "user.name", "github-actions[bot]"])
  execaSync("git", ["config", "user.email", "github-actions[bot]@users.noreply.github.com"])
  execaSync("git", ["add", "-u", "--", manifest, "bun.lock"])

  const tagExists =
    execaSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { reject: false }).exitCode === 0
  const staged = execaSync("git", ["diff", "--cached", "--quiet"], { reject: false }).exitCode !== 0
  if (staged) execaSync("git", ["commit", "-m", `chore(release): bump version to ${version}`])
  const releaseSha = execaSync("git", ["rev-parse", "HEAD"]).stdout

  if (tagExists && !staged) {
    console.log(`Tag ${tag} already points at the checked version; nothing to commit.`)
  } else if (tagExists) {
    execaSync("git", ["fetch", "origin", defaultBranch])
    execaSync("git", ["checkout", "--detach", "FETCH_HEAD"])
    const picked = execaSync("git", ["cherry-pick", releaseSha], { reject: false })
    if (picked.exitCode !== 0) {
      if (execaSync("git", ["diff", "--cached", "--quiet"], { reject: false }).exitCode !== 0) {
        throw new Error(`\`git cherry-pick ${releaseSha}\` failed: ${picked.stderr.trim() || picked.stdout.trim()}`)
      }
      execaSync("git", ["cherry-pick", "--skip"])
      console.log(`Version bump for ${tag} is already on ${defaultBranch}; nothing to cherry-pick.`)
    } else {
      push("origin", `HEAD:refs/heads/${defaultBranch}`)
      console.log(`Cherry-picked the version bump for ${tag} onto ${defaultBranch}.`)
    }
  } else {
    execaSync("git", ["tag", tag])
    push("--atomic", "origin", `HEAD:refs/heads/${defaultBranch}`, `refs/tags/${tag}`)
    console.log(`Tagged ${tag} and pushed it with ${defaultBranch}.`)
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${releaseSha}\n`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
