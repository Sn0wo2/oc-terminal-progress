import { appendFileSync } from "node:fs"
import { graphql } from "@octokit/graphql"

try {
  for (const name of ["GITHUB_REPOSITORY", "GH_TOKEN", "GITHUB_OUTPUT"]) {
    if (!process.env[name]) throw new Error(`${name} is not set`)
  }
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME
  if (!tag) throw new Error("Release tag is not set")
  const [owner, name] = process.env.GITHUB_REPOSITORY.split("/")
  if (!(owner && name)) throw new Error("GITHUB_REPOSITORY must be in owner/name format")

  const {
    repository: { release },
  } = await graphql(
    `query($owner: String!, $name: String!, $tag: String!) {
      repository(owner: $owner, name: $name) {
        release(tagName: $tag) { isDraft }
      }
    }`,
    {
      owner,
      name,
      tag,
      headers: { authorization: `Bearer ${process.env.GH_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    },
  )

  const skip = release !== null && !release.isDraft
  appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`)
  console.log(skip ? `Release ${tag} is already published; skipping.` : `Release ${tag} is not published; continuing.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
