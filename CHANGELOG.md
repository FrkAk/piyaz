# Changelog

## [0.3.0](https://github.com/FrkAk/piyaz/compare/v0.2.0...v0.3.0) (2026-06-30)


### ⚠ BREAKING CHANGES

* the 0002 migration drops the legacy `history` JSONB columns from `tasks` and `projects`, which the activity-log backfill reads. Self-hosters must run `scripts/backfill-activity-events.sql` (as service_role) while on v0.2.0, before upgrading to v0.3.0 and running `bun run db:migrate`. The backfill script ships only in v0.2.0 and is removed in v0.3.0, so it cannot be run after upgrading; instances already backfilled on v0.2.0 need no extra step.

### Features

* Add email sender resolver and capability detection ([#166](https://github.com/FrkAk/piyaz/issues/166)) ([a16f912](https://github.com/FrkAk/piyaz/commit/a16f91204f7c71466ff8bcda84c6bad06f5437ac))
* Define EmailSender interface and email message types ([#152](https://github.com/FrkAk/piyaz/issues/152)) ([bcec3ef](https://github.com/FrkAk/piyaz/commit/bcec3ef50a4548a681b293843e204a0f303c2a90))
* Implement LogSender dev email transport ([#164](https://github.com/FrkAk/piyaz/issues/164)) ([c930a4f](https://github.com/FrkAk/piyaz/commit/c930a4f9a56f9646c53aed4266c9fecbde6f6547))


### Bug Fixes

* require double-click to edit inline fields ([#165](https://github.com/FrkAk/piyaz/issues/165)) ([699dc58](https://github.com/FrkAk/piyaz/commit/699dc587ddd052c45390603325a86fb1f8e908d0))


### Code Refactoring

* drop legacy history JSONB columns ([#168](https://github.com/FrkAk/piyaz/issues/168)) ([ed8de04](https://github.com/FrkAk/piyaz/commit/ed8de04376bba2e2abf756973a70694f2778b7a7))

## [0.2.0](https://github.com/FrkAk/piyaz/compare/v0.1.2...v0.2.0) (2026-06-28)


### Features

* attributed activity log for tasks and projects ([#133](https://github.com/FrkAk/piyaz/issues/133)) ([1553505](https://github.com/FrkAk/piyaz/commit/1553505e0cf0e627a2ed63213babf72cb2046ba1))


### Bug Fixes

* harden composer behaviour in sub-stages ([#156](https://github.com/FrkAk/piyaz/issues/156)) ([41a1f5e](https://github.com/FrkAk/piyaz/commit/41a1f5e6964b9d97c1e1bdbfe735e5af9eb6e5f7))
* let migrator create cross-schema fks to piyaz_auth ([#162](https://github.com/FrkAk/piyaz/issues/162)) ([628fb2c](https://github.com/FrkAk/piyaz/commit/628fb2cd0bb58d166d3023abe5b468580e335aca))
