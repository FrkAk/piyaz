# Changelog

## [0.3.0](https://github.com/FrkAk/piyaz/compare/v0.2.0...v0.3.0) (2026-07-05)


### ⚠ BREAKING CHANGES

* piyaz_project/task/edge/query/context/analyze are removed; the MCP surface is now piyaz_workspace/search/get/create/edit/link/map/activity. Once this deploys to prod, plugins still on 0.2.x call the removed tools and their skills carry stale prompts against the old surface. Users must update their plugin to 0.3.0.
* the 0002 migration drops the legacy `history` JSONB columns from `tasks` and `projects`, which the activity-log backfill reads. Self-hosters must run `scripts/backfill-activity-events.sql` (as service_role) while on v0.2.0, before upgrading to v0.3.0 and running `bun run db:migrate`. The backfill script ships only in v0.2.0 and is removed in v0.3.0, so it cannot be run after upgrading; instances already backfilled on v0.2.0 need no extra step.

### Features

* Add email sender resolver and capability detection ([#166](https://github.com/FrkAk/piyaz/issues/166)) ([a16f912](https://github.com/FrkAk/piyaz/commit/a16f91204f7c71466ff8bcda84c6bad06f5437ac))
* build Notes data layer ([#172](https://github.com/FrkAk/piyaz/issues/172)) ([8fa6c8d](https://github.com/FrkAk/piyaz/commit/8fa6c8db8bdd4afae4e69c71a83da0f303185a29))
* Create Notes DB schema, indexes, and RLS migration ([#169](https://github.com/FrkAk/piyaz/issues/169)) ([ec14217](https://github.com/FrkAk/piyaz/commit/ec1421747c88b5f8c463ef13fcd03426aee98053))
* Define EmailSender interface and email message types ([#152](https://github.com/FrkAk/piyaz/issues/152)) ([bcec3ef](https://github.com/FrkAk/piyaz/commit/bcec3ef50a4548a681b293843e204a0f303c2a90))
* Implement LogSender dev email transport ([#164](https://github.com/FrkAk/piyaz/issues/164)) ([c930a4f](https://github.com/FrkAk/piyaz/commit/c930a4f9a56f9646c53aed4266c9fecbde6f6547))
* redesign mcp surface as 8 ref-first tools ([#170](https://github.com/FrkAk/piyaz/issues/170)) ([576d2bd](https://github.com/FrkAk/piyaz/commit/576d2bd1b309e0194b1b42bfdd4ab7191f097298))
* wire notes workspace view ([#173](https://github.com/FrkAk/piyaz/issues/173)) ([25effee](https://github.com/FrkAk/piyaz/commit/25effeec2f2b2f762b48b4fabf4dade8d2071b49))


### Bug Fixes

* require double-click to edit inline fields ([#165](https://github.com/FrkAk/piyaz/issues/165)) ([699dc58](https://github.com/FrkAk/piyaz/commit/699dc587ddd052c45390603325a86fb1f8e908d0))


### Documentation

* rewrite README ([#171](https://github.com/FrkAk/piyaz/issues/171)) ([90c4a7f](https://github.com/FrkAk/piyaz/commit/90c4a7f676ad59af558020e2eca7a1edbda02379))


### Code Refactoring

* drop legacy history JSONB columns ([#168](https://github.com/FrkAk/piyaz/issues/168)) ([ed8de04](https://github.com/FrkAk/piyaz/commit/ed8de04376bba2e2abf756973a70694f2778b7a7))

## [0.2.0](https://github.com/FrkAk/piyaz/compare/v0.1.2...v0.2.0) (2026-06-28)


### Features

* attributed activity log for tasks and projects ([#133](https://github.com/FrkAk/piyaz/issues/133)) ([1553505](https://github.com/FrkAk/piyaz/commit/1553505e0cf0e627a2ed63213babf72cb2046ba1))


### Bug Fixes

* harden composer behaviour in sub-stages ([#156](https://github.com/FrkAk/piyaz/issues/156)) ([41a1f5e](https://github.com/FrkAk/piyaz/commit/41a1f5e6964b9d97c1e1bdbfe735e5af9eb6e5f7))
* let migrator create cross-schema fks to piyaz_auth ([#162](https://github.com/FrkAk/piyaz/issues/162)) ([628fb2c](https://github.com/FrkAk/piyaz/commit/628fb2cd0bb58d166d3023abe5b468580e335aca))
