# Anti-slop provenance

Source: the `install-anti-slop` skill's bundled `assets/anti-slop` snapshot.

Upstream repository and revision: unknown. The downloaded skill bundle did not include repository metadata or a revision identifier, so no commit is claimed for the generic or Effect plugin sources.

Installed plugin entry points:

- `tools/oxlint/anti-slop/index.ts`
- `tools/oxlint/anti-slop/effect/index.ts`

The generic plugin is registered in `.oxlintrc.json`. The Effect plugin is present in the vendored snapshot but is intentionally not registered because this workspace has no direct `effect` dependency.

## Intentional deviations

- Added this provenance record beside the installed entry point; the bundled snapshot did not contain a top-level provenance file.
- Repository configuration ignores the complete vendored plugin directory during application linting.

The nested readability implementation has independent source and license records in `vendor/eslint-stylistic/UPSTREAM.md` and `vendor/eslint-stylistic/LICENSE`. Preserve both when updating or redistributing this plugin.
