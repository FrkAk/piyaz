# Changelog

## [0.4.3](https://github.com/FrkAk/piyaz/compare/v0.4.2...v0.4.3) (2026-07-16)


### Bug Fixes

* add og image and enable link unfurls ([#232](https://github.com/FrkAk/piyaz/issues/232)) ([d7feb44](https://github.com/FrkAk/piyaz/commit/d7feb44419c0240060bab49d69b32513cd2c2e40))

## [0.4.2](https://github.com/FrkAk/piyaz/compare/v0.4.1...v0.4.2) (2026-07-16)


### Bug Fixes

* enable public signups on production ([#230](https://github.com/FrkAk/piyaz/issues/230)) ([36b749b](https://github.com/FrkAk/piyaz/commit/36b749ba74d8aefe8125a6609c5109cfd42f7280))

## [0.4.1](https://github.com/FrkAk/piyaz/compare/v0.4.0...v0.4.1) (2026-07-15)


### Bug Fixes

* hard-navigate to app root after auth to fix blank screen ([#227](https://github.com/FrkAk/piyaz/issues/227)) ([e670db8](https://github.com/FrkAk/piyaz/commit/e670db88ea28c40cd3f6ec78d11e1ed964114dfd))

## [0.4.0](https://github.com/FrkAk/piyaz/compare/v0.3.0...v0.4.0) (2026-07-15)


### Features

* add brand config and per-type sender address selection ([#207](https://github.com/FrkAk/piyaz/issues/207)) ([386e138](https://github.com/FrkAk/piyaz/commit/386e13841165edb828b20d79d7410749b17267f3))
* add keyboard-accessible note move to notes tree ([#205](https://github.com/FrkAk/piyaz/issues/205)) ([7b8d812](https://github.com/FrkAk/piyaz/commit/7b8d81240e904f586838f4fbdaac4ac8d0c484ac))
* add legal_acceptances table with rls and version source of truth ([#176](https://github.com/FrkAk/piyaz/issues/176)) ([005b078](https://github.com/FrkAk/piyaz/commit/005b0783b59aa936840f6cfd69c3388fd9a9ba56))
* add linked notes section to task DetailView ([#190](https://github.com/FrkAk/piyaz/issues/190)) ([43a6362](https://github.com/FrkAk/piyaz/commit/43a6362b20a1209cf74487e3041e2a8e49104230))
* add note query keys, server-action mutations, and autosave ([#179](https://github.com/FrkAk/piyaz/issues/179)) ([ba96c2f](https://github.com/FrkAk/piyaz/commit/ba96c2f3908a2c02d328a1a8bf4a33613d3e10aa))
* add notes activity and version history view ([#211](https://github.com/FrkAk/piyaz/issues/211)) ([2f9010a](https://github.com/FrkAk/piyaz/commit/2f9010ad781d34fbd39a63219ce801f7925b516e))
* add Notes API routes with conditional-GET and slim egress ([#177](https://github.com/FrkAk/piyaz/issues/177)) ([0200d8a](https://github.com/FrkAk/piyaz/commit/0200d8aee40143edfa28cb1406025176cc1a7faa))
* add notes to the global command palette search ([#192](https://github.com/FrkAk/piyaz/issues/192)) ([2602f99](https://github.com/FrkAk/piyaz/commit/2602f99ccfbd41aa9e42a027974f191e8cc43316))
* add signup consent gate and record acceptance ([#181](https://github.com/FrkAk/piyaz/issues/181)) ([6ebc9c5](https://github.com/FrkAk/piyaz/commit/6ebc9c5463a7a36d95ddb74af255ff96c790c4c5))
* add transactional email HTML templates ([#209](https://github.com/FrkAk/piyaz/issues/209)) ([3d0af0d](https://github.com/FrkAk/piyaz/commit/3d0af0d4b6f9bbdd1d61bf3d4c48d2cc1c259a3c))
* build email auth ui and invitation delivery ([#225](https://github.com/FrkAk/piyaz/issues/225)) ([fe911ca](https://github.com/FrkAk/piyaz/commit/fe911ca21d47ca18c9bf79ed81e09543543da19a))
* build piyaz_note MCP tool on the v2 ref-first surface ([#197](https://github.com/FrkAk/piyaz/issues/197)) ([f2a6c2a](https://github.com/FrkAk/piyaz/commit/f2a6c2a7fa62910f1dfff0099d130077b22741ea))
* Build self-serve account deletion and DSAR path ([#184](https://github.com/FrkAk/piyaz/issues/184)) ([b2a46be](https://github.com/FrkAk/piyaz/commit/b2a46beb1898fa26a11579e19576d0c4052395ad))
* enforce note agent-write and locked gates at the MCP surface ([#198](https://github.com/FrkAk/piyaz/issues/198)) ([edd0fb4](https://github.com/FrkAk/piyaz/commit/edd0fb4635773239bdc4a7d8ea64ee44f513d412))
* extend auth email templates for security context and new flows ([#219](https://github.com/FrkAk/piyaz/issues/219)) ([6e73a6c](https://github.com/FrkAk/piyaz/commit/6e73a6c4312c4774e7ed537574c5115dbb23ed88))
* gate access on re-acceptance of updated legal docs ([#215](https://github.com/FrkAk/piyaz/issues/215)) ([08dc8a4](https://github.com/FrkAk/piyaz/commit/08dc8a48a23790e3790411800838d704604d5a64))
* harden the composer workflow pipeline ([#220](https://github.com/FrkAk/piyaz/issues/220)) ([2962adc](https://github.com/FrkAk/piyaz/commit/2962adc71a5fe54afd4cb607fac3c12f344ae485))
* implement feed resolution agent-exposure gate ([#174](https://github.com/FrkAk/piyaz/issues/174)) ([0ff34e0](https://github.com/FrkAk/piyaz/commit/0ff34e0c0d00378b0a6997a4199d2391be277c3e))
* implement the Notes settings ribbon ([#189](https://github.com/FrkAk/piyaz/issues/189)) ([3d898d1](https://github.com/FrkAk/piyaz/commit/3d898d18764a281b290c214f10949837458269eb))
* inject exposed notes into task context bundles ([#199](https://github.com/FrkAk/piyaz/issues/199)) ([90ad038](https://github.com/FrkAk/piyaz/commit/90ad038816bbb344e0a353a073177bbd5ea6f85c))
* notes in the project graph with link kinds, preview, egress, and mobile ([#221](https://github.com/FrkAk/piyaz/issues/221)) ([f680a5b](https://github.com/FrkAk/piyaz/commit/f680a5b7862913d976ad55ccf9da58aee55e5322))
* notes UI polish, touch usability, and fed notes in the bundle preview ([#218](https://github.com/FrkAk/piyaz/issues/218)) ([ccc9aad](https://github.com/FrkAk/piyaz/commit/ccc9aad3cc7e2c3d0130ef27e1559131499b3a29))
* offer and record b2b data processing agreement ([#183](https://github.com/FrkAk/piyaz/issues/183)) ([3fea284](https://github.com/FrkAk/piyaz/commit/3fea284dbb75a812c14cf6ef382a7ae6cd2f09b7))
* Promote shared icons and port the Notes three-pane shell and tree ([#182](https://github.com/FrkAk/piyaz/issues/182)) ([626fd33](https://github.com/FrkAk/piyaz/commit/626fd33a7a982aa788421b2cb4872b50cbde8b11))
* publish public legal pages and visible links ([#178](https://github.com/FrkAk/piyaz/issues/178)) ([183fa1c](https://github.com/FrkAk/piyaz/commit/183fa1c706b4dd1408e757a151e2fd61ac492c7e))
* Publish sub-processor list and change notification ([#180](https://github.com/FrkAk/piyaz/issues/180)) ([eeb1ac1](https://github.com/FrkAk/piyaz/commit/eeb1ac1b9473f2055fe674b17161f0e0d6a07288))
* render notes as full markdown with a click-to-source editor ([#194](https://github.com/FrkAk/piyaz/issues/194)) ([9c2cb1b](https://github.com/FrkAk/piyaz/commit/9c2cb1bf61f9af3c561818ead50fd5708009cc5c))
* resolve note refs and hint summary-less notes in note search ([#217](https://github.com/FrkAk/piyaz/issues/217)) ([f2f2dde](https://github.com/FrkAk/piyaz/commit/f2f2dde75e62dc59e9f6bb06d13d57b56ddccb46))
* ship cloudflare email sending transport and workers config ([#216](https://github.com/FrkAk/piyaz/issues/216)) ([f902d63](https://github.com/FrkAk/piyaz/commit/f902d6317ae4936affd7f49a55f1349eb9b62e15))
* sort and group the notes tree like the structure view ([#208](https://github.com/FrkAk/piyaz/issues/208)) ([198f3ae](https://github.com/FrkAk/piyaz/commit/198f3ae859c0a4949f58c8a0f898e6875c49862b))
* the live block editor with inline task and note links ([#187](https://github.com/FrkAk/piyaz/issues/187)) ([284ce8a](https://github.com/FrkAk/piyaz/commit/284ce8a19b2041bc4d877799517315dd04cb65ac))
* wire better auth email flows and rollout safety ([#223](https://github.com/FrkAk/piyaz/issues/223)) ([6ba1bf5](https://github.com/FrkAk/piyaz/commit/6ba1bf574286f02f4c616ca254414188a716cc18))
* wire SSE note invalidation, conflict banner, and presence ([#210](https://github.com/FrkAk/piyaz/issues/210)) ([6438f68](https://github.com/FrkAk/piyaz/commit/6438f6837fc8e0ba92399e3dc64d251d91f56f8c))


### Bug Fixes

* fill notes rail panes and animate optimistic tree edits ([#202](https://github.com/FrkAk/piyaz/issues/202)) ([c6cdf72](https://github.com/FrkAk/piyaz/commit/c6cdf725441de8748f5b3b8cf8dfbb3a390eb5c3))
* merge and rank notes and tasks in the note link picker ([#191](https://github.com/FrkAk/piyaz/issues/191)) ([ab9bfa6](https://github.com/FrkAk/piyaz/commit/ab9bfa66aeefc80e6596c52fcb1ff81274f534d9))
* patch better-auth request-state ALS init race ([#226](https://github.com/FrkAk/piyaz/issues/226)) ([c4a305e](https://github.com/FrkAk/piyaz/commit/c4a305e04320308cbc86f4e913582bc7f7f87832))
* persist note folders and honor the selected folder on create ([#201](https://github.com/FrkAk/piyaz/issues/201)) ([01e422e](https://github.com/FrkAk/piyaz/commit/01e422ee49601d455420f294b690ab25000e11bb))
* reconcile editor note title with cache renames ([#196](https://github.com/FrkAk/piyaz/issues/196)) ([f9f84d9](https://github.com/FrkAk/piyaz/commit/f9f84d9955e56777a3f1e87437d572c2eda2db9d))
* serialize and CAS-guard note move, delete, and restore writes ([#206](https://github.com/FrkAk/piyaz/issues/206)) ([2b1d3cd](https://github.com/FrkAk/piyaz/commit/2b1d3cd9fd2f890b757f95b41825da34fb5ce95d))
* Surface bulk folder-delete partial failures ([#213](https://github.com/FrkAk/piyaz/issues/213)) ([4cb5056](https://github.com/FrkAk/piyaz/commit/4cb5056b0f5e5fb24b21555c72b94dc936bd5273))
* surface note-task links and fix notes MCP defects ([#214](https://github.com/FrkAk/piyaz/issues/214)) ([dadefc7](https://github.com/FrkAk/piyaz/commit/dadefc7c7e2b9644abc8d75228da7f1cb6ffbda1))


### Performance Improvements

* eliminate the notes tree render storm ([#203](https://github.com/FrkAk/piyaz/issues/203)) ([1c63da7](https://github.com/FrkAk/piyaz/commit/1c63da7781a51f1e7b59a9994b076df0088f5966))


### Documentation

* align legal docs and add compliance guardrails ([#224](https://github.com/FrkAk/piyaz/issues/224)) ([f749857](https://github.com/FrkAk/piyaz/commit/f7498575c43b633a51511ad1f91152cda28c102d))
* finalize preliminary beta legal docs ([#186](https://github.com/FrkAk/piyaz/issues/186)) ([386cfe0](https://github.com/FrkAk/piyaz/commit/386cfe02ca5509ac9adb2b4316a255a800e381e9))
* lowercase service references and drop stale draft docstrings ([#212](https://github.com/FrkAk/piyaz/issues/212)) ([aafe252](https://github.com/FrkAk/piyaz/commit/aafe25286fe80210de3fdb0f83e111bd691f6436))


### Code Refactoring

* Batch AutoGrowTextarea layout reads to cut per-input reflow ([#200](https://github.com/FrkAk/piyaz/issues/200)) ([9565fda](https://github.com/FrkAk/piyaz/commit/9565fda71f47a3fd3658dc887b389447b40f77c7))
* share an animated drawer and collapsible rail ([#193](https://github.com/FrkAk/piyaz/issues/193)) ([0029a1c](https://github.com/FrkAk/piyaz/commit/0029a1cfdd3dee89689a1ab1d008b2bde5966151))

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
