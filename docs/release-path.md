# Release path

Stable and beta GitHub Releases are created by workflows. Do not hand-edit
release assets locally.

## Stable (`master` / `main`)

[`.github/workflows/releases.yml`](../.github/workflows/releases.yml) runs on
every **push** to `master` or `main`. Merge, squash, and rebase of a pull
request all produce that push, so they all cut a release. A second
`pull_request.closed` trigger is intentionally omitted (it would double-fire).

The workflow:

1. Infers the merged branch via the commit’s associated pull request.
2. Picks the next SemVer from conventional branch prefixes (and follows an
   existing `X.Y.Z-beta.N` series for that same `X.Y.Z`).
3. Calls [`.github/workflows/plugin-build.yml`](../.github/workflows/plugin-build.yml)
   to compile and zip.
4. Attests provenance and publishes a non-prerelease GitHub Release.
5. Commits `chore(release): <version>` with changelog and manifests.

`chore(release)` and `[skip release]` in the head commit message skip the
workflow so the bump commit cannot loop.

`workflow_dispatch` still accepts an explicit `bump` (`patch` / `minor` /
`major`) or `version`. `bump: none` uses branch inference (patch if there is
no PR).

If branch protection blocks `GITHUB_TOKEN` from pushing to the default
branch, the version commit step fails after the GitHub Release exists. Use a
fine-grained PAT only if protection requires it.

## Beta (conventional branches)

[`.github/workflows/beta-release.yml`](../.github/workflows/beta-release.yml)
runs on push to typed implementation branches. It is not `master` / `main`,
and it does not commit generated versions back to the branch.

Prefixes (keep in sync with the workflow globs):

-   `feature/**` or `feature-*`
-   `feat/**` or `feat-*` → **minor** beta base (`3.2.0-beta.N` if `3.1.1` is tagged)
-   `fix/**`, `fix-*`, `bug/**`, `bug-*`, `bugfix/**`, `bugfix-*`, `hotfix/**`, `hotfix-*` → **patch**
-   `breaking/**`, `breaking-*`, `major/**`, `major-*` → **major**
-   `chore`, `deps`, `docs`, `refactor`, `perf`, `test(s)`, `ci`, `build`, `style` → **patch**

`cursor/**` is not included, so Cloud Agent branches do not publish betas.

Each beta is a GitHub **prerelease** named `Beta <version>` with BRAT assets:

-   `main.js`
-   `manifest.json`
-   `styles.css`
-   `obsidian-git-<beta-version>.zip`

Merging that branch to `master` publishes the matching stable `X.Y.Z` (for
example `3.2.0-beta.5` becomes `3.2.0`), not an extra bump past the beta.
