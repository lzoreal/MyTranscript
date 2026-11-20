# 播放器脚本依赖清单

由 `python scripts/player_js_deps.py` 生成，只统计顶层声明与跨分片引用。
新搬一段代码前先查这里，确认它的外部依赖是否只有少数几项。

- 分片：11 个；顶层声明：770 个；跨分片引用：386 个。

| 声明 | 定义片 | 引用分片（次数） | 总引用 |
| --- | --- | --- | --- |
| `$` | 01-theme-reader-shell.js | 00-kernel.js 9<br>02-live-caption-wasm.js 5<br>03-native-asr-service-worker.js 34<br>04-local-audio-plugin-host.js 34<br>05-transport-transcript-nav.js 143<br>06-catalog-feeds-search.js 12<br>07-routes-pages.js 90<br>08-study-ai.js 3<br>09-player-integration.js 30<br>10-desktop-bridge-tail.js 149 | 613 |
| `state` | 01-theme-reader-shell.js | 00-kernel.js 1<br>02-live-caption-wasm.js 6<br>03-native-asr-service-worker.js 50<br>04-local-audio-plugin-host.js 45<br>05-transport-transcript-nav.js 123<br>06-catalog-feeds-search.js 17<br>07-routes-pages.js 21<br>09-player-integration.js 70<br>10-desktop-bridge-tail.js 82 | 534 |
| `host` | 02-live-caption-wasm.js | 01-theme-reader-shell.js 7<br>03-native-asr-service-worker.js 15<br>04-local-audio-plugin-host.js 12<br>05-transport-transcript-nav.js 49<br>06-catalog-feeds-search.js 1<br>07-routes-pages.js 11<br>08-study-ai.js 1<br>09-player-integration.js 1<br>10-desktop-bridge-tail.js 16 | 122 |
| `setState` | 01-theme-reader-shell.js | 02-live-caption-wasm.js 1<br>03-native-asr-service-worker.js 61<br>04-local-audio-plugin-host.js 22<br>05-transport-transcript-nav.js 44<br>06-catalog-feeds-search.js 3<br>07-routes-pages.js 4<br>09-player-integration.js 1<br>10-desktop-bridge-tail.js 10 | 186 |
| `showToast` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 6<br>04-local-audio-plugin-host.js 8<br>05-transport-transcript-nav.js 58<br>06-catalog-feeds-search.js 9<br>07-routes-pages.js 8<br>08-study-ai.js 1<br>09-player-integration.js 5<br>10-desktop-bridge-tail.js 71 | 178 |
| `prefs` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 2<br>02-live-caption-wasm.js 4<br>03-native-asr-service-worker.js 8<br>06-catalog-feeds-search.js 6<br>07-routes-pages.js 8<br>08-study-ai.js 9<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 38 | 120 |
| `audio` | 01-theme-reader-shell.js | 02-live-caption-wasm.js 40<br>03-native-asr-service-worker.js 35<br>04-local-audio-plugin-host.js 17<br>05-transport-transcript-nav.js 64<br>07-routes-pages.js 1<br>09-player-integration.js 6<br>10-desktop-bridge-tail.js 33 | 240 |
| `reader` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>04-local-audio-plugin-host.js 5<br>05-transport-transcript-nav.js 4<br>07-routes-pages.js 13<br>08-study-ai.js 1<br>09-player-integration.js 5<br>10-desktop-bridge-tail.js 3 | 62 |
| `app` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 5<br>03-native-asr-service-worker.js 9<br>04-local-audio-plugin-host.js 65<br>06-catalog-feeds-search.js 50<br>07-routes-pages.js 88<br>09-player-integration.js 10<br>10-desktop-bridge-tail.js 162 | 516 |
| `status` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 10<br>04-local-audio-plugin-host.js 19<br>05-transport-transcript-nav.js 11<br>06-catalog-feeds-search.js 12<br>07-routes-pages.js 8<br>08-study-ai.js 3 | 72 |
| `seekTo` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1<br>04-local-audio-plugin-host.js 3<br>05-transport-transcript-nav.js 4<br>07-routes-pages.js 1<br>09-player-integration.js 1<br>10-desktop-bridge-tail.js 3 | 15 |
| `tauriHost` | 02-live-caption-wasm.js | 01-theme-reader-shell.js 3<br>03-native-asr-service-worker.js 1<br>04-local-audio-plugin-host.js 13<br>05-transport-transcript-nav.js 1<br>07-routes-pages.js 5<br>10-desktop-bridge-tail.js 8 | 38 |
| `subtitlePluginOn` | 04-local-audio-plugin-host.js | 01-theme-reader-shell.js 3<br>03-native-asr-service-worker.js 3<br>05-transport-transcript-nav.js 1<br>06-catalog-feeds-search.js 1<br>08-study-ai.js 1<br>09-player-integration.js 1 | 17 |
| `isJsonTranscript` | 00-kernel.js | 01-theme-reader-shell.js 1<br>03-native-asr-service-worker.js 1<br>05-transport-transcript-nav.js 6<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 12 |
| `getJson` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1<br>06-catalog-feeds-search.js 1<br>10-desktop-bridge-tail.js 1 | 7 |
| `LIVE` | 02-live-caption-wasm.js | 01-theme-reader-shell.js 2<br>03-native-asr-service-worker.js 140<br>04-local-audio-plugin-host.js 4<br>05-transport-transcript-nav.js 3<br>10-desktop-bridge-tail.js 7 | 294 |
| `writeJSON` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1<br>04-local-audio-plugin-host.js 2<br>07-routes-pages.js 2<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 8 | 24 |
| `syncMini` | 09-player-integration.js | 01-theme-reader-shell.js 1<br>03-native-asr-service-worker.js 3<br>05-transport-transcript-nav.js 2<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 4 | 14 |
| `emptyLine` | 00-kernel.js | 01-theme-reader-shell.js 1<br>04-local-audio-plugin-host.js 3<br>05-transport-transcript-nav.js 3<br>07-routes-pages.js 23 | 32 |
| `parseFeed` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1<br>06-catalog-feeds-search.js 3<br>10-desktop-bridge-tail.js 2 | 8 |
| `paint` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 4<br>05-transport-transcript-nav.js 17<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 4 | 31 |
| `selectEpisode` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 5<br>07-routes-pages.js 1<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 1 | 10 |
| `offlineKeyFor` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 2<br>04-local-audio-plugin-host.js 1<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 4 | 14 |
| `showByKey` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 2<br>06-catalog-feeds-search.js 3<br>07-routes-pages.js 19<br>10-desktop-bridge-tail.js 11 | 42 |
| `episodesOf` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 3<br>07-routes-pages.js 8<br>09-player-integration.js 1<br>10-desktop-bridge-tail.js 5 | 20 |
| `navigate` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 8<br>06-catalog-feeds-search.js 3<br>07-routes-pages.js 6<br>10-desktop-bridge-tail.js 21 | 41 |
| `studyNormText` | 00-kernel.js | 01-theme-reader-shell.js 1<br>04-local-audio-plugin-host.js 1<br>10-desktop-bridge-tail.js 4 | 8 |
| `pluginPageKey` | 00-kernel.js | 01-theme-reader-shell.js 1<br>04-local-audio-plugin-host.js 3<br>07-routes-pages.js 2 | 8 |
| `applyReader` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 3<br>05-transport-transcript-nav.js 1<br>10-desktop-bridge-tail.js 2 | 12 |
| `rebuildCues` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 3<br>05-transport-transcript-nav.js 1<br>10-desktop-bridge-tail.js 1 | 9 |
| `saveProgress` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1<br>04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 6 | 9 |
| `cuesFromJson` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1<br>04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1 | 4 |
| `syncJumpPill` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 3<br>04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 5 | 16 |
| `defineCoreProvider` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1<br>10-desktop-bridge-tail.js 2 | 5 |
| `coreProvider` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 1<br>10-desktop-bridge-tail.js 2 | 6 |
| `liveDisable` | 03-native-asr-service-worker.js | 02-live-caption-wasm.js 1<br>04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 1 | 7 |
| `smallArtwork` | 04-local-audio-plugin-host.js | 06-catalog-feeds-search.js 2<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 1 | 7 |
| `loadShow` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 1<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 4 |
| `emitPlugin` | 04-local-audio-plugin-host.js | 01-theme-reader-shell.js 1<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 4 | 8 |
| `closeDockSheet` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 6<br>04-local-audio-plugin-host.js 2<br>10-desktop-bridge-tail.js 2 | 16 |
| `syncDockSleep` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 1<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 4 | 10 |
| `readJSON` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1<br>04-local-audio-plugin-host.js 1<br>06-catalog-feeds-search.js 13 | 17 |
| `hash32` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 1<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 2 | 6 |
| `hostOf` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2<br>07-routes-pages.js 3<br>10-desktop-bridge-tail.js 3 | 10 |
| `cleanFeedTitle` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 1<br>06-catalog-feeds-search.js 3<br>10-desktop-bridge-tail.js 2 | 7 |
| `refreshShows` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 2<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 3 | 10 |
| `catalogLatest` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 1<br>07-routes-pages.js 4<br>10-desktop-bridge-tail.js 1 | 8 |
| `showPrefFor` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 4 | 9 |
| `isPlayed` | 05-transport-transcript-nav.js | 07-routes-pages.js 1<br>09-player-integration.js 1<br>10-desktop-bridge-tail.js 4 | 10 |
| `formatDate` | 05-transport-transcript-nav.js | 07-routes-pages.js 7<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 1 | 11 |
| `routeHash` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 2 | 6 |
| `moduleOn` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1<br>04-local-audio-plugin-host.js 2<br>07-routes-pages.js 2 | 25 |
| `rememberFeed` | 06-catalog-feeds-search.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1<br>10-desktop-bridge-tail.js 2 | 6 |
| `memoryFeed` | 06-catalog-feeds-search.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 2<br>07-routes-pages.js 1 | 7 |
| `hasFreshFeed` | 06-catalog-feeds-search.js | 04-local-audio-plugin-host.js 1<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 4 |
| `fetchFeedText` | 06-catalog-feeds-search.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1<br>10-desktop-bridge-tail.js 1 | 7 |
| `ensureShowFeed` | 06-catalog-feeds-search.js | 04-local-audio-plugin-host.js 1<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 3 | 7 |
| `studyCache` | 08-study-ai.js | 03-native-asr-service-worker.js 1<br>04-local-audio-plugin-host.js 1<br>10-desktop-bridge-tail.js 6 | 11 |
| `closeStudySheet` | 08-study-ai.js | 01-theme-reader-shell.js 2<br>04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 3 | 8 |
| `syncReaderTop` | 09-player-integration.js | 03-native-asr-service-worker.js 1<br>04-local-audio-plugin-host.js 3<br>07-routes-pages.js 1 | 6 |
| `syncBookmarkBtn` | 09-player-integration.js | 03-native-asr-service-worker.js 3<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 7 |
| `syncMiniCaption` | 09-player-integration.js | 01-theme-reader-shell.js 2<br>04-local-audio-plugin-host.js 1<br>07-routes-pages.js 1 | 7 |
| `openModal` | 10-desktop-bridge-tail.js | 01-theme-reader-shell.js 1<br>05-transport-transcript-nav.js 1<br>06-catalog-feeds-search.js 1 | 7 |
| `statHTML` | 00-kernel.js | 01-theme-reader-shell.js 1<br>07-routes-pages.js 12 | 15 |
| `listBox` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>04-local-audio-plugin-host.js 5 | 8 |
| `syncCustomThemeEditor` | 01-theme-reader-shell.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 3 |
| `directAudioUrl` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1 | 4 |
| `closeDrawer` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1<br>05-transport-transcript-nav.js 2 | 6 |
| `openDetails` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3<br>10-desktop-bridge-tail.js 1 | 5 |
| `closeOverlays` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2<br>10-desktop-bridge-tail.js 1 | 6 |
| `setImmersive` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3<br>10-desktop-bridge-tail.js 1 | 6 |
| `wpLastKey` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1<br>09-player-integration.js 1 | 6 |
| `wallpaperRefresh` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1<br>09-player-integration.js 1 | 5 |
| `renderCues` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>05-transport-transcript-nav.js 3 | 10 |
| `updateTimeScale` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1<br>05-transport-transcript-nav.js 1 | 3 |
| `rawSeek` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 7<br>10-desktop-bridge-tail.js 2 | 11 |
| `LIVE_LEAD_DEFAULT` | 02-live-caption-wasm.js | 05-transport-transcript-nav.js 1<br>06-catalog-feeds-search.js 1 | 5 |
| `liveMseStop` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 4<br>10-desktop-bridge-tail.js 1 | 8 |
| `liveUpdateMeter` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1<br>10-desktop-bridge-tail.js 1 | 4 |
| `studyPluginOn` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 1<br>08-study-ai.js 1 | 7 |
| `pluginPlayerState` | 04-local-audio-plugin-host.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 4 | 9 |
| `refreshPluginSettings` | 04-local-audio-plugin-host.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 3 | 5 |
| `dockSheet` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1<br>10-desktop-bridge-tail.js 2 | 21 |
| `syncDockBadge` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 2<br>07-routes-pages.js 2 | 9 |
| `applyVolume` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 1<br>10-desktop-bridge-tail.js 1 | 6 |
| `ensureAudioGraph` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1<br>10-desktop-bridge-tail.js 1 | 4 |
| `applyLoudness` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1<br>10-desktop-bridge-tail.js 2 | 4 |
| `syncChapterNow` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1<br>03-native-asr-service-worker.js 1 | 4 |
| `cleanWord` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 4<br>10-desktop-bridge-tail.js 1 | 7 |
| `closeWordPanel` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 1<br>10-desktop-bridge-tail.js 2 | 5 |
| `refreshOffline` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1<br>10-desktop-bridge-tail.js 3 | 6 |
| `fmtBytes` | 05-transport-transcript-nav.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 14 |
| `refreshAsrModels` | 05-transport-transcript-nav.js | 08-study-ai.js 1<br>10-desktop-bridge-tail.js 4 | 10 |
| `renderDownloads` | 05-transport-transcript-nav.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 4 |
| `renderOfflineList` | 05-transport-transcript-nav.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 6 |
| `ASR_MODEL_DEFAULT` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1<br>06-catalog-feeds-search.js 1 | 9 |
| `PAGE_NAMES` | 05-transport-transcript-nav.js | 07-routes-pages.js 3<br>09-player-integration.js 1 | 5 |
| `syncIndexCount` | 05-transport-transcript-nav.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 2 | 9 |
| `normalizeFeedUrl` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 1<br>10-desktop-bridge-tail.js 3 | 6 |
| `absoluteUrl` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 1<br>10-desktop-bridge-tail.js 1 | 4 |
| `absoluteFeed` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 3<br>07-routes-pages.js 2 | 7 |
| `findBuiltinByFeed` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 1<br>10-desktop-bridge-tail.js 2 | 4 |
| `isSubscribed` | 05-transport-transcript-nav.js | 07-routes-pages.js 5<br>10-desktop-bridge-tail.js 5 | 13 |
| `saveSubs` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2<br>10-desktop-bridge-tail.js 1 | 7 |
| `readAllProgress` | 05-transport-transcript-nav.js | 07-routes-pages.js 4<br>10-desktop-bridge-tail.js 2 | 8 |
| `isFavorite` | 05-transport-transcript-nav.js | 07-routes-pages.js 2<br>10-desktop-bridge-tail.js 2 | 7 |
| `plainText` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 1<br>07-routes-pages.js 3 | 5 |
| `normalizeSidebarPrefs` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 1<br>08-study-ai.js 2 | 6 |
| `applySidebarCustomization` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 2<br>08-study-ai.js 3 | 7 |
| `parseRoute` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 1<br>07-routes-pages.js 2 | 7 |
| `renderAfterStateChange` | 05-transport-transcript-nav.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 10 | 18 |
| `loadLocalState` | 06-catalog-feeds-search.js | 04-local-audio-plugin-host.js 1<br>10-desktop-bridge-tail.js 1 | 3 |
| `exportSubtitle` | 06-catalog-feeds-search.js | 04-local-audio-plugin-host.js 2<br>10-desktop-bridge-tail.js 1 | 4 |
| `coverHTML` | 06-catalog-feeds-search.js | 07-routes-pages.js 6<br>10-desktop-bridge-tail.js 1 | 10 |
| `renderOnlineResults` | 06-catalog-feeds-search.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 7 |
| `applyRoute` | 07-routes-pages.js | 04-local-audio-plugin-host.js 1<br>10-desktop-bridge-tail.js 1 | 3 |
| `renderPage` | 07-routes-pages.js | 04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 1 | 6 |
| `searchTab` | 07-routes-pages.js | 05-transport-transcript-nav.js 2<br>10-desktop-bridge-tail.js 2 | 11 |
| `renderSearch` | 07-routes-pages.js | 05-transport-transcript-nav.js 2<br>10-desktop-bridge-tail.js 3 | 7 |
| `saveQueue` | 07-routes-pages.js | 05-transport-transcript-nav.js 1<br>10-desktop-bridge-tail.js 4 | 7 |
| `renderListening` | 07-routes-pages.js | 01-theme-reader-shell.js 1<br>10-desktop-bridge-tail.js 4 | 7 |
| `TR` | 07-routes-pages.js | 04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 3 | 29 |
| `trReady` | 07-routes-pages.js | 03-native-asr-service-worker.js 1<br>04-local-audio-plugin-host.js 1 | 5 |
| `trSave` | 07-routes-pages.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1 | 3 |
| `trBatch` | 07-routes-pages.js | 02-live-caption-wasm.js 2<br>04-local-audio-plugin-host.js 1 | 6 |
| `trNoteError` | 07-routes-pages.js | 03-native-asr-service-worker.js 1<br>04-local-audio-plugin-host.js 1 | 4 |
| `trPrimeCues` | 07-routes-pages.js | 01-theme-reader-shell.js 1<br>04-local-audio-plugin-host.js 1 | 3 |
| `syncTranslateSettings` | 07-routes-pages.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1 | 5 |
| `studyView` | 08-study-ai.js | 04-local-audio-plugin-host.js 2<br>10-desktop-bridge-tail.js 2 | 5 |
| `openStudySheet` | 08-study-ai.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 1 | 4 |
| `studyDueItems` | 08-study-ai.js | 04-local-audio-plugin-host.js 1<br>10-desktop-bridge-tail.js 1 | 3 |
| `studyOpenEpisodeSummary` | 08-study-ai.js | 04-local-audio-plugin-host.js 1<br>10-desktop-bridge-tail.js 1 | 4 |
| `studyClockSeconds` | 08-study-ai.js | 03-native-asr-service-worker.js 2<br>10-desktop-bridge-tail.js 1 | 4 |
| `syncThemeSwatches` | 08-study-ai.js | 07-routes-pages.js 1<br>10-desktop-bridge-tail.js 1 | 3 |
| `openSettingsPane` | 08-study-ai.js | 04-local-audio-plugin-host.js 4<br>10-desktop-bridge-tail.js 2 | 7 |
| `stepEpisode` | 09-player-integration.js | 05-transport-transcript-nav.js 5<br>10-desktop-bridge-tail.js 10 | 16 |
| `savePrefs` | 10-desktop-bridge-tail.js | 05-transport-transcript-nav.js 7<br>08-study-ai.js 3 | 22 |
| `playEpisode` | 10-desktop-bridge-tail.js | 04-local-audio-plugin-host.js 1<br>05-transport-transcript-nav.js 2 | 7 |
| `closeThemePop` | 10-desktop-bridge-tail.js | 01-theme-reader-shell.js 1<br>07-routes-pages.js 1 | 5 |
| `MYTK` | 00-kernel.js | 01-theme-reader-shell.js 1 | 2 |
| `studyRegexEscape` | 00-kernel.js | 01-theme-reader-shell.js 1 | 3 |
| `themeBtns` | 01-theme-reader-shell.js | 08-study-ai.js 1 | 4 |
| `rememberOverlayTrigger` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 1 | 5 |
| `restoreOverlayFocus` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 1 | 5 |
| `readCustomTheme` | 01-theme-reader-shell.js | 10-desktop-bridge-tail.js 1 | 5 |
| `writeCustomTheme` | 01-theme-reader-shell.js | 10-desktop-bridge-tail.js 1 | 3 |
| `applyCustomTheme` | 01-theme-reader-shell.js | 10-desktop-bridge-tail.js 1 | 6 |
| `closeTypeSheet` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 10 |
| `resetImportUI` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 3 |
| `PROGRESS_KEY` | 01-theme-reader-shell.js | 10-desktop-bridge-tail.js 1 | 5 |
| `progressAllCache` | 01-theme-reader-shell.js | 10-desktop-bridge-tail.js 1 | 9 |
| `progressAll` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 1 | 5 |
| `writeProgressAll` | 01-theme-reader-shell.js | 10-desktop-bridge-tail.js 1 | 4 |
| `progressKey` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 3 |
| `readProgress` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 2 |
| `clearProgress` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 1 | 2 |
| `preferredAudioUrl` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 4 |
| `onAudioError` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 1 | 2 |
| `openDrawer` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 3 |
| `closeDetails` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 5 | 9 |
| `wpPrevIndex` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 6 |
| `wpCueIndex` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 6 |
| `wpEpId` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 4 |
| `syncWallpaperPlay` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 5 |
| `toggleWallpaperPlay` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 1 | 2 |
| `setWallpaper` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3 | 5 |
| `sitePath` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 2 |
| `deriveZhUrl` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 2 |
| `deriveTimingsUrl` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 2 |
| `getText` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 3 |
| `transcriptMirror` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 1 | 3 |
| `vttFromSidecar` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 2 |
| `parseZhVTT` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 3 |
| `parseVttSmart` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 4 |
| `mergeCues` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 6 |
| `splitLabel` | 01-theme-reader-shell.js | 09-player-integration.js 1 | 4 |
| `alignZhLines` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 1 | 2 |
| `renderCueWindow` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 4 |
| `stopScroll` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 5 | 7 |
| `scrollCue` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 4 | 9 |
| `liveFollow` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 1 | 2 |
| `LIVE_RATE` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 14 |
| `CORE_PROVIDER_NAMES` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 1 | 4 |
| `registerCoreProvider` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 1 | 2 |
| `releaseCoreProviders` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 1 | 2 |
| `coreProviderOwner` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 1 | 2 |
| `LIVE_ENGINE_KIND` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 4 |
| `liveMediaTime` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 2 |
| `liveMediaOf` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 7 | 8 |
| `liveBarHideTimer` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 3 | 10 |
| `liveSetText` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 10 | 22 |
| `livePlayhead` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 5 |
| `syncLiveLeadSelect` | 02-live-caption-wasm.js | 07-routes-pages.js 1 | 2 |
| `liveRetry` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 3 |
| `liveProbeAudio` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 3 |
| `liveWaitAudioReady` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 2 |
| `liveMseCapable` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 4 |
| `liveMseBegin` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 4 |
| `liveMseReanchor` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 4 |
| `liveStartPump` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 2 |
| `liveStopPump` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 3 | 4 |
| `liveLoadEngine` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 2 |
| `liveEmitTokens` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 3 |
| `liveSherpaStream` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 2 |
| `liveNativeLoad` | 03-native-asr-service-worker.js | 02-live-caption-wasm.js 1 | 2 |
| `liveClearRows` | 03-native-asr-service-worker.js | 02-live-caption-wasm.js 1 | 6 |
| `liveRebuildStream` | 03-native-asr-service-worker.js | 02-live-caption-wasm.js 3 | 10 |
| `liveWordTimes` | 03-native-asr-service-worker.js | 02-live-caption-wasm.js 1 | 3 |
| `liveRenderLine` | 03-native-asr-service-worker.js | 02-live-caption-wasm.js 2 | 8 |
| `liveAdvance` | 03-native-asr-service-worker.js | 01-theme-reader-shell.js 1 | 2 |
| `liveEnable` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 1 | 4 |
| `applyEpisodeData` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 1 | 4 |
| `sanitizeAdRanges` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 2 | 4 |
| `mergeAdRanges` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 2 | 4 |
| `studyAdRangesFromData` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 1 | 3 |
| `studyApplyAiAdRanges` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 1 | 3 |
| `skipUrlOf` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 1 | 3 |
| `findSkipRange` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 1 | 2 |
| `localAsrAvailable` | 04-local-audio-plugin-host.js | 01-theme-reader-shell.js 1 | 3 |
| `openLocalTranscript` | 04-local-audio-plugin-host.js | 03-native-asr-service-worker.js 1 | 2 |
| `startLocalTranscribe` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 1 | 2 |
| `clipListen` | 04-local-audio-plugin-host.js | 01-theme-reader-shell.js 1 | 3 |
| `clipNow` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 1 | 5 |
| `renderList` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 1 | 8 |
| `PLUGIN_PAGES` | 04-local-audio-plugin-host.js | 07-routes-pages.js 1 | 5 |
| `PluginHost` | 04-local-audio-plugin-host.js | 01-theme-reader-shell.js 1 | 31 |
| `pluginReportError` | 04-local-audio-plugin-host.js | 07-routes-pages.js 1 | 17 |
| `registerStudyUiHook` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 5 | 6 |
| `studyUi` | 04-local-audio-plugin-host.js | 08-study-ai.js 8 | 10 |
| `studyRuntime` | 04-local-audio-plugin-host.js | 08-study-ai.js 18 | 20 |
| `studyEngine` | 04-local-audio-plugin-host.js | 08-study-ai.js 6 | 8 |
| `clearPluginConsent` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 1 | 3 |
| `reloadPlugins` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 1 | 2 |
| `renderPluginPage` | 04-local-audio-plugin-host.js | 07-routes-pages.js 1 | 2 |
| `initPlayer` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 1 | 2 |
| `seekBy` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 2 | 8 |
| `syncDockLang` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1 | 3 |
| `syncRateSeg` | 05-transport-transcript-nav.js | 07-routes-pages.js 2 | 5 |
| `applyRate` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 4 |
| `setAlignMode` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1 | 6 |
| `alignToCue` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1 | 2 |
| `returnToCue` | 05-transport-transcript-nav.js | 07-routes-pages.js 1 | 4 |
| `framePos` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 3 | 10 |
| `placeFrame` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1 | 4 |
| `copyPlain` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 2 | 4 |
| `loadChapters` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1 | 2 |
| `seekChapter` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `toggleChapterSheet` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 3 | 6 |
| `lookupWord` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1 | 2 |
| `playPlaylist` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `removePlaylist` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `addToPlaylistDialog` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `renderPlaylists` | 05-transport-transcript-nav.js | 07-routes-pages.js 1 | 2 |
| `offlineKeyOf` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1 | 3 |
| `saveOfflineTranscript` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1 | 3 |
| `readTranscriptDoc` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1 | 3 |
| `asrModelName` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 4 | 7 |
| `localAsrModelId` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 5 | 7 |
| `renderLocalAsrModelHint` | 05-transport-transcript-nav.js | 08-study-ai.js 1 | 3 |
| `paintAsrSoon` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `installAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 3 |
| `cancelAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `openAsrDir` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `pickAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `removeAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `importAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `downloadEpisode` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 3 | 4 |
| `removeOffline` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 3 |
| `offlineEntries` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 4 |
| `resolveOfflineRef` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 3 | 8 |
| `offlineLabel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 4 |
| `playOffline` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `SUBS_KEY` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2 | 4 |
| `AUTO_DEFAULTS` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 1 | 2 |
| `SIDEBAR_META` | 05-transport-transcript-nav.js | 08-study-ai.js 1 | 3 |
| `THEME_NAMES` | 05-transport-transcript-nav.js | 07-routes-pages.js 1 | 2 |
| `whenIdle` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1 | 2 |
| `idxGetAll` | 05-transport-transcript-nav.js | 07-routes-pages.js 1 | 3 |
| `idxClear` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `indexCurrentEpisode` | 05-transport-transcript-nav.js | 03-native-asr-service-worker.js 1 | 2 |
| `indexAllShows` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `indexCurrentShow` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `extSlug` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 3 | 4 |
| `subscribeShow` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 4 | 5 |
| `subscribeRecord` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 4 | 5 |
| `unsubscribeKey` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 3 |
| `saveFavorites` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 3 |
| `savePlayed` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `saveInbox` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 4 |
| `saveSeen` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `saveShowPrefs` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 3 |
| `setShowPref` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 5 | 6 |
| `toggleFavorite` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `setPlayed` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `addInboxItem` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 1 | 2 |
| `inboxRemove` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 3 |
| `inboxCount` | 05-transport-transcript-nav.js | 07-routes-pages.js 2 | 3 |
| `episodeFilterMatch` | 05-transport-transcript-nav.js | 07-routes-pages.js 1 | 2 |
| `epStatusBadges` | 05-transport-transcript-nav.js | 07-routes-pages.js 1 | 2 |
| `fmtDuration` | 05-transport-transcript-nav.js | 07-routes-pages.js 4 | 5 |
| `routeModuleAllows` | 05-transport-transcript-nav.js | 07-routes-pages.js 1 | 6 |
| `sidebarOrder` | 05-transport-transcript-nav.js | 08-study-ai.js 2 | 4 |
| `applyModules` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 1 | 3 |
| `bindModuleSwitches` | 05-transport-transcript-nav.js | 04-local-audio-plugin-host.js 1 | 2 |
| `firstShowKey` | 05-transport-transcript-nav.js | 07-routes-pages.js 1 | 2 |
| `loadCatalog` | 06-catalog-feeds-search.js | 04-local-audio-plugin-host.js 1 | 2 |
| `mergeCatalog` | 06-catalog-feeds-search.js | 04-local-audio-plugin-host.js 1 | 2 |
| `feedCachePut` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 1 | 4 |
| `parseOpml` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 1 | 2 |
| `downloadFile` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 2 | 7 |
| `checkSubscriptions` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 1 | 2 |
| `stamp` | 06-catalog-feeds-search.js | 03-native-asr-service-worker.js 6 | 11 |
| `shareCurrentCue` | 06-catalog-feeds-search.js | 01-theme-reader-shell.js 1 | 2 |
| `exportOpml` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 2 | 3 |
| `copyText` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 2 | 3 |
| `coverGrad` | 06-catalog-feeds-search.js | 09-player-integration.js 1 | 4 |
| `initialsOf` | 06-catalog-feeds-search.js | 09-player-integration.js 2 | 5 |
| `episodeCover` | 06-catalog-feeds-search.js | 07-routes-pages.js 6 | 7 |
| `ONLINE_PAGE` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 2 | 8 |
| `feedKey` | 06-catalog-feeds-search.js | 05-transport-transcript-nav.js 2 | 8 |
| `runOnlineSearch` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 4 | 5 |
| `openOnlineDetail` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 1 | 2 |
| `subscribeFromOnline` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 1 | 2 |
| `updateDocumentTitle` | 07-routes-pages.js | 03-native-asr-service-worker.js 1 | 4 |
| `openPlayerRoute` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 3 |
| `renderHome` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 3 |
| `renderLibrary` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 3 |
| `renderDiscover` | 07-routes-pages.js | 10-desktop-bridge-tail.js 5 | 7 |
| `renderLocal` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 5 |
| `importLocalFolder` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 2 |
| `renderPodcast` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 5 |
| `renderInbox` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 4 |
| `addToQueue` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 2 |
| `renderQueue` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 4 |
| `renderHistory` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 3 |
| `renderEcho` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 3 |
| `renderBookmarks` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 3 |
| `renderNotes` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 4 |
| `LISTEN_APPEARANCE` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 4 |
| `LISTEN_CONTINUE` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 4 |
| `renderAutoSettings` | 07-routes-pages.js | 10-desktop-bridge-tail.js 1 | 3 |
| `TR_CACHE` | 07-routes-pages.js | 04-local-audio-plugin-host.js 2 | 7 |
| `trNative` | 07-routes-pages.js | 04-local-audio-plugin-host.js 1 | 4 |
| `trStatus` | 07-routes-pages.js | 04-local-audio-plugin-host.js 1 | 7 |
| `trText` | 07-routes-pages.js | 03-native-asr-service-worker.js 1 | 2 |
| `STUDY` | 08-study-ai.js | 04-local-audio-plugin-host.js 3 | 6 |
| `studyAutoPause` | 08-study-ai.js | 04-local-audio-plugin-host.js 2 | 3 |
| `applyStudyEngine` | 08-study-ai.js | 04-local-audio-plugin-host.js 4 | 5 |
| `applyStudyRuntime` | 08-study-ai.js | 04-local-audio-plugin-host.js 4 | 5 |
| `saveStudyCache` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 2 |
| `bindStudyUI` | 08-study-ai.js | 04-local-audio-plugin-host.js 1 | 3 |
| `bindWordStatusButtons` | 08-study-ai.js | 05-transport-transcript-nav.js 2 | 4 |
| `syncStudySettings` | 08-study-ai.js | 07-routes-pages.js 1 | 4 |
| `wordStatusHTML` | 08-study-ai.js | 05-transport-transcript-nav.js 2 | 4 |
| `studyApplyWordMarks` | 08-study-ai.js | 01-theme-reader-shell.js 1 | 4 |
| `studyAddVocab` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 3 |
| `studyMarkWord` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 3 |
| `studyStats` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 2 |
| `studyExportCsv` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 4 |
| `studyEpisodeHTML` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 3 |
| `studyRenderEpisode` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 3 |
| `studyRenderPractice` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 3 |
| `studyLangName` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 2 |
| `studyReady` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 3 |
| `studyChat` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 3 |
| `studyParseJson` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 3 |
| `studyCurrentCue` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 2 |
| `studyCueBounds` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 2 |
| `studyPlayRange` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 2 |
| `renderSidebarSettings` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 6 |
| `resetSidebarSettings` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 2 |
| `bindLedgerUI` | 09-player-integration.js | 04-local-audio-plugin-host.js 1 | 2 |
| `toggleBookmarkCue` | 09-player-integration.js | 10-desktop-bridge-tail.js 1 | 2 |
| `currentPlaylist` | 09-player-integration.js | 10-desktop-bridge-tail.js 2 | 6 |
| `nextTarget` | 09-player-integration.js | 10-desktop-bridge-tail.js 1 | 3 |
| `toggleMiniCaption` | 09-player-integration.js | 10-desktop-bridge-tail.js 1 | 2 |
| `startSleepTimer` | 10-desktop-bridge-tail.js | 06-catalog-feeds-search.js 1 | 3 |
| `setSleep` | 10-desktop-bridge-tail.js | 05-transport-transcript-nav.js 2 | 4 |
| `syncAutoNextSwitch` | 10-desktop-bridge-tail.js | 07-routes-pages.js 1 | 3 |
| `playNextAuto` | 10-desktop-bridge-tail.js | 05-transport-transcript-nav.js 1 | 3 |
| `closeModal` | 10-desktop-bridge-tail.js | 05-transport-transcript-nav.js 2 | 12 |
| `addFeedFromUrl` | 10-desktop-bridge-tail.js | 06-catalog-feeds-search.js 1 | 4 |
| `desktopNotify` | 10-desktop-bridge-tail.js | 05-transport-transcript-nav.js 1 | 4 |
| `startAutoRefresh` | 10-desktop-bridge-tail.js | 04-local-audio-plugin-host.js 1 | 4 |
| `autoCleanup` | 10-desktop-bridge-tail.js | 05-transport-transcript-nav.js 1 | 3 |
| `bindShell` | 10-desktop-bridge-tail.js | 04-local-audio-plugin-host.js 1 | 2 |
