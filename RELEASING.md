# Releasing agentlore

Releases are automated with [Changesets](https://changesets.dev) and
`.github/workflows/release.yml`. Nobody publishes from a laptop except for the very first
version (see below).

## How a release happens

1. Every pull request with a user-facing change includes a changeset (`pnpm changeset`).
2. On each push to `main`, the Release workflow runs `changesets/action`:
   - while changesets are pending, it opens or updates a **"chore: release"** pull request that
     bumps the version in `package.json`, writes `CHANGELOG.md` and deletes the changesets;
   - when that pull request is merged, it runs `pnpm changeset publish`, which publishes the
     new version to npm (`prepublishOnly` runs lint, typecheck, tests and the build first),
     pushes the `vX.Y.Z` tag and creates the GitHub release.
3. Check the package page on npm: the version should show a **provenance** badge linking to
   the workflow run that built it.

Pull requests opened by the workflow's `GITHUB_TOKEN` do not trigger other workflows, so CI does
not run on the release pull request by itself. Its only changes are the version, the changelog
and removed changesets; if you want CI on it, close and reopen it, or push an empty commit to
its branch.

## One-time setup: npm trusted publishing (OIDC)

The workflow publishes with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers):
npm accepts a short-lived OIDC token from GitHub Actions instead of a long-lived `NPM_TOKEN`
secret, and attaches [provenance](https://docs.npmjs.com/generating-provenance-statements)
automatically. Trusted publishing needs npm 11.5.1 or newer, which is why the workflow uses
Node 24.

1. **First publish.** A trusted publisher can only be configured for a package that already
   exists on npm. Publish the first version manually from a clean checkout of `main`:

   ```bash
   pnpm install --frozen-lockfile
   pnpm changeset version   # applies the pending changesets, e.g. 0.0.0 → 0.1.0
   git commit -am "chore: release" && git push
   npm login
   pnpm publish --access public   # prepublishOnly runs all checks and the build
   git tag v$(node -p "require('./package.json').version") && git push --tags
   ```

2. **Configure the trusted publisher.** On npmjs.com open the package → *Settings* →
   *Trusted Publisher* → *GitHub Actions*, and enter:
   - Organization or user: `hodfords-solutions`
   - Repository: `agentlore`
   - Workflow filename: `release.yml`
   - Environment: leave empty (unless you add one to the workflow)

3. **Lock it down.** In the same settings page, set *Publishing access* to "Require two-factor
   authentication and disallow tokens", so only the workflow (and you, with 2FA) can publish.
   Do not add an `NPM_TOKEN` secret to the repository.

4. **GitHub settings.** In the repository's *Settings → Actions → General*, allow GitHub Actions
   to create pull requests ("Allow GitHub Actions to create and approve pull requests"), which
   the release pull request needs. Under *Settings → Code security*, enable **Private
   vulnerability reporting**, which [SECURITY.md](SECURITY.md) relies on.

## If a publish fails

The workflow can be re-run safely: `changeset publish` skips versions that already exist on
npm. If the version was published but the tag or GitHub release is missing, create them by hand
from the release commit.
