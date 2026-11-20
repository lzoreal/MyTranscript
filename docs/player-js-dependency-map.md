# 播放器脚本依赖清单

由 `python scripts/player_js_deps.py` 生成，只统计顶层声明与跨分片引用。
新搬一段代码前先查这里，确认它的外部依赖是否只有少数几项。

- 分片：14 个；顶层声明：868 个；跨分片引用：413 个。

| 声明 | 定义片 | 引用分片（次数） | 总引用 |
| --- | --- | --- | --- |
| `$` | 00-runtime.js | 00-kernel.js 9<br>01-theme-reader-shell.js 130<br>02-live-caption-wasm.js 6<br>03-native-asr-service-worker.js 33<br>04-local-audio-plugin-host.js 37<br>05-transport-transcript-nav.js 144<br>06-catalog-feeds-search.js 13<br>07-routes-pages.js 91<br>08-study-ai.js 4<br>09-player-integration.js 31<br>10-desktop-bridge-tail.js 152 | 655 |
| `audio` | 00-runtime.js | 01-theme-reader-shell.js 48<br>02-live-caption-wasm.js 41<br>03-native-asr-service-worker.js 36<br>04-local-audio-plugin-host.js 19<br>05-transport-transcript-nav.js 66<br>06-catalog-feeds-search.js 1<br>07-routes-pages.js 2<br>08-study-ai.js 1<br>09-player-integration.js 8<br>10-desktop-bridge-tail.js 38<br>player.js 2 | 267 |
| `host` | 00-runtime.js | 01-theme-reader-shell.js 13<br>02-live-caption-wasm.js 7<br>03-native-asr-service-worker.js 18<br>04-local-audio-plugin-host.js 24<br>05-transport-transcript-nav.js 51<br>06-catalog-feeds-search.js 2<br>07-routes-pages.js 13<br>08-study-ai.js 2<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 19<br>player.js 2 | 156 |
| `state` | 00-runtime.js | 00-kernel.js 1<br>01-theme-reader-shell.js 116<br>02-live-caption-wasm.js 7<br>03-native-asr-service-worker.js 50<br>04-local-audio-plugin-host.js 46<br>05-transport-transcript-nav.js 124<br>06-catalog-feeds-search.js 18<br>07-routes-pages.js 22<br>09-player-integration.js 71<br>10-desktop-bridge-tail.js 85 | 546 |
| `prefs` | 00-runtime.js | 01-theme-reader-shell.js 3<br>02-live-caption-wasm.js 5<br>03-native-asr-service-worker.js 9<br>04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 43<br>06-catalog-feeds-search.js 6<br>07-routes-pages.js 9<br>08-study-ai.js 10<br>09-player-integration.js 3<br>10-desktop-bridge-tail.js 38 | 135 |
| `setState` | 00-runtime.js | 01-theme-reader-shell.js 39<br>02-live-caption-wasm.js 1<br>03-native-asr-service-worker.js 62<br>04-local-audio-plugin-host.js 23<br>05-transport-transcript-nav.js 45<br>06-catalog-feeds-search.js 4<br>07-routes-pages.js 5<br>09-player-integration.js 1<br>10-desktop-bridge-tail.js 11 | 195 |
| `reader` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 4<br>04-local-audio-plugin-host.js 8<br>05-transport-transcript-nav.js 6<br>06-catalog-feeds-search.js 1<br>07-routes-pages.js 15<br>08-study-ai.js 2<br>09-player-integration.js 7<br>10-desktop-bridge-tail.js 5<br>player.js 1 | 86 |
| `showToast` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 7<br>04-local-audio-plugin-host.js 11<br>05-transport-transcript-nav.js 59<br>06-catalog-feeds-search.js 10<br>07-routes-pages.js 9<br>08-study-ai.js 2<br>09-player-integration.js 6<br>10-desktop-bridge-tail.js 78 | 205 |
| `tauriHost` | 00-runtime.js | 01-theme-reader-shell.js 4<br>02-live-caption-wasm.js 5<br>03-native-asr-service-worker.js 2<br>04-local-audio-plugin-host.js 18<br>05-transport-transcript-nav.js 2<br>07-routes-pages.js 6<br>10-desktop-bridge-tail.js 10 | 51 |
| `subtitlePluginOn` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 5<br>04-local-audio-plugin-host.js 9<br>05-transport-transcript-nav.js 2<br>06-catalog-feeds-search.js 2<br>08-study-ai.js 2<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 2 | 29 |
| `app` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 11<br>04-local-audio-plugin-host.js 71<br>05-transport-transcript-nav.js 129<br>06-catalog-feeds-search.js 51<br>07-routes-pages.js 89<br>09-player-integration.js 11<br>10-desktop-bridge-tail.js 165 | 534 |
| `LIVE` | 00-runtime.js | 01-theme-reader-shell.js 3<br>02-live-caption-wasm.js 138<br>03-native-asr-service-worker.js 139<br>04-local-audio-plugin-host.js 6<br>05-transport-transcript-nav.js 4<br>10-desktop-bridge-tail.js 8 | 301 |
| `status` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 12<br>04-local-audio-plugin-host.js 21<br>05-transport-transcript-nav.js 12<br>06-catalog-feeds-search.js 12<br>07-routes-pages.js 8<br>08-study-ai.js 3 | 79 |
| `seekTo` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>04-local-audio-plugin-host.js 4<br>05-transport-transcript-nav.js 5<br>07-routes-pages.js 2<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 5 | 24 |
| `isJsonTranscript` | 00-kernel.js | 01-theme-reader-shell.js 3<br>03-native-asr-service-worker.js 2<br>05-transport-transcript-nav.js 7<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 2 | 18 |
| `writeJSON` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 4<br>05-transport-transcript-nav.js 11<br>07-routes-pages.js 3<br>09-player-integration.js 3<br>10-desktop-bridge-tail.js 9 | 33 |
| `syncMini` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 5<br>05-transport-transcript-nav.js 4<br>07-routes-pages.js 4<br>09-player-integration.js 4<br>10-desktop-bridge-tail.js 5 | 25 |
| `getJson` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 3<br>04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 2<br>06-catalog-feeds-search.js 2<br>10-desktop-bridge-tail.js 2 | 14 |
| `emptyLine` | 00-kernel.js | 01-theme-reader-shell.js 3<br>04-local-audio-plugin-host.js 5<br>05-transport-transcript-nav.js 4<br>07-routes-pages.js 24 | 38 |
| `pending` | 00-layers.js | 01-theme-reader-shell.js 10<br>02-live-caption-wasm.js 2<br>03-native-asr-service-worker.js 5<br>10-desktop-bridge-tail.js 7 | 30 |
| `parseFeed` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 2<br>06-catalog-feeds-search.js 4<br>10-desktop-bridge-tail.js 3 | 14 |
| `paint` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 5<br>05-transport-transcript-nav.js 18<br>07-routes-pages.js 1<br>10-desktop-bridge-tail.js 5 | 36 |
| `offlineKeyFor` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 3<br>05-transport-transcript-nav.js 8<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 5 | 22 |
| `selectEpisode` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 6<br>07-routes-pages.js 2<br>09-player-integration.js 3<br>10-desktop-bridge-tail.js 2 | 16 |
| `episodesOf` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5<br>07-routes-pages.js 9<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 6 | 28 |
| `navigate` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5<br>06-catalog-feeds-search.js 4<br>07-routes-pages.js 7<br>10-desktop-bridge-tail.js 22 | 48 |
| `showByKey` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 9<br>06-catalog-feeds-search.js 4<br>07-routes-pages.js 20<br>10-desktop-bridge-tail.js 13 | 51 |
| `syncDockSleep` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5<br>06-catalog-feeds-search.js 2<br>07-routes-pages.js 3<br>10-desktop-bridge-tail.js 5 | 18 |
| `LOCAL_KEY` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>06-catalog-feeds-search.js 2<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 3 | 13 |
| `studyNormText` | 00-kernel.js | 01-theme-reader-shell.js 3<br>04-local-audio-plugin-host.js 2<br>10-desktop-bridge-tail.js 5 | 12 |
| `statHTML` | 00-kernel.js | 01-theme-reader-shell.js 3<br>04-local-audio-plugin-host.js 2<br>07-routes-pages.js 13 | 20 |
| `pluginPageKey` | 00-kernel.js | 01-theme-reader-shell.js 3<br>04-local-audio-plugin-host.js 4<br>07-routes-pages.js 3 | 12 |
| `ASR_MODEL_DEFAULT` | 00-runtime.js | 03-native-asr-service-worker.js 2<br>05-transport-transcript-nav.js 6<br>06-catalog-feeds-search.js 2 | 14 |
| `emitPlugin` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 3<br>07-routes-pages.js 3<br>10-desktop-bridge-tail.js 5 | 14 |
| `closeDockSheet` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 4<br>05-transport-transcript-nav.js 8<br>10-desktop-bridge-tail.js 3 | 23 |
| `readJSON` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 3<br>05-transport-transcript-nav.js 4<br>06-catalog-feeds-search.js 14 | 25 |
| `closeStudySheet` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 4<br>05-transport-transcript-nav.js 5<br>08-study-ai.js 3 | 16 |
| `syncMiniCaption` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 3<br>07-routes-pages.js 3<br>09-player-integration.js 5 | 15 |
| `openModal` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3<br>06-catalog-feeds-search.js 3<br>10-desktop-bridge-tail.js 6 | 15 |
| `syncCustomThemeEditor` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 2<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 2 | 9 |
| `applyReader` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 4<br>05-transport-transcript-nav.js 2<br>10-desktop-bridge-tail.js 3 | 17 |
| `rebuildCues` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 4<br>05-transport-transcript-nav.js 2<br>10-desktop-bridge-tail.js 2 | 14 |
| `saveProgress` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 7 | 14 |
| `cuesFromJson` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 2 | 9 |
| `syncJumpPill` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 4<br>04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 6 | 21 |
| `liveDisable` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 3<br>04-local-audio-plugin-host.js 3<br>05-transport-transcript-nav.js 2 | 11 |
| `defineCoreProvider` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 2<br>10-desktop-bridge-tail.js 3 | 10 |
| `coreProvider` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 3<br>05-transport-transcript-nav.js 2<br>10-desktop-bridge-tail.js 3 | 11 |
| `moduleOn` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 6<br>05-transport-transcript-nav.js 22<br>07-routes-pages.js 3 | 34 |
| `routeHash` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 4<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 3 | 12 |
| `showPrefFor` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 5<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 5 | 15 |
| `syncDockBadge` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 3<br>05-transport-transcript-nav.js 7<br>07-routes-pages.js 3 | 17 |
| `syncBookmarkBtn` | 03-native-asr-service-worker.js | 07-routes-pages.js 3<br>09-player-integration.js 4<br>10-desktop-bridge-tail.js 2 | 14 |
| `syncReaderTop` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 5<br>07-routes-pages.js 3<br>09-player-integration.js 3 | 14 |
| `studyCache` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 3<br>08-study-ai.js 5<br>10-desktop-bridge-tail.js 7 | 18 |
| `absoluteFeed` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4<br>06-catalog-feeds-search.js 4<br>07-routes-pages.js 3 | 15 |
| `catalogLatest` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4<br>07-routes-pages.js 5<br>10-desktop-bridge-tail.js 2 | 15 |
| `cleanFeedTitle` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>06-catalog-feeds-search.js 4<br>10-desktop-bridge-tail.js 3 | 13 |
| `fmtBytes` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 14<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 2 | 22 |
| `isSubscribed` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5<br>07-routes-pages.js 6<br>10-desktop-bridge-tail.js 6 | 21 |
| `readAllProgress` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4<br>07-routes-pages.js 5<br>10-desktop-bridge-tail.js 3 | 15 |
| `refreshShows` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 6<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 4 | 16 |
| `coverHTML` | 04-local-audio-plugin-host.js | 06-catalog-feeds-search.js 5<br>07-routes-pages.js 7<br>10-desktop-bridge-tail.js 2 | 17 |
| `ensureShowFeed` | 04-local-audio-plugin-host.js | 06-catalog-feeds-search.js 3<br>07-routes-pages.js 3<br>10-desktop-bridge-tail.js 4 | 13 |
| `fetchFeedText` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>06-catalog-feeds-search.js 6<br>10-desktop-bridge-tail.js 2 | 14 |
| `hasFreshFeed` | 04-local-audio-plugin-host.js | 06-catalog-feeds-search.js 3<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 2 | 10 |
| `memoryFeed` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4<br>06-catalog-feeds-search.js 5<br>07-routes-pages.js 2 | 14 |
| `rememberFeed` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>06-catalog-feeds-search.js 4<br>10-desktop-bridge-tail.js 3 | 13 |
| `syncThemeSwatches` | 04-local-audio-plugin-host.js | 07-routes-pages.js 3<br>08-study-ai.js 3<br>10-desktop-bridge-tail.js 2 | 11 |
| `smallArtwork` | 04-local-audio-plugin-host.js | 06-catalog-feeds-search.js 3<br>09-player-integration.js 3<br>10-desktop-bridge-tail.js 2 | 12 |
| `loadShow` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 2<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 3 | 10 |
| `hash32` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2<br>07-routes-pages.js 2<br>10-desktop-bridge-tail.js 3 | 11 |
| `hostOf` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 3<br>07-routes-pages.js 4<br>10-desktop-bridge-tail.js 4 | 15 |
| `isPlayed` | 05-transport-transcript-nav.js | 07-routes-pages.js 2<br>09-player-integration.js 2<br>10-desktop-bridge-tail.js 5 | 15 |
| `formatDate` | 05-transport-transcript-nav.js | 07-routes-pages.js 8<br>09-player-integration.js 3<br>10-desktop-bridge-tail.js 2 | 16 |
| `listBox` | 00-runtime.js | 03-native-asr-service-worker.js 3<br>04-local-audio-plugin-host.js 6 | 12 |
| `LIVE_RATE` | 00-runtime.js | 02-live-caption-wasm.js 11<br>03-native-asr-service-worker.js 2 | 18 |
| `LIVE_LEAD_DEFAULT` | 00-runtime.js | 02-live-caption-wasm.js 3<br>06-catalog-feeds-search.js 2 | 9 |
| `replacePrefs` | 00-runtime.js | 06-catalog-feeds-search.js 2<br>10-desktop-bridge-tail.js 2 | 7 |
| `syncChapterNow` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 3<br>05-transport-transcript-nav.js 4 | 10 |
| `renderListening` | 01-theme-reader-shell.js | 07-routes-pages.js 4<br>10-desktop-bridge-tail.js 5 | 12 |
| `trPrimeCues` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 3<br>07-routes-pages.js 3 | 9 |
| `studyResetPlayback` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 3<br>08-study-ai.js 3 | 9 |
| `closeThemePop` | 01-theme-reader-shell.js | 07-routes-pages.js 3<br>10-desktop-bridge-tail.js 5 | 12 |
| `readCustomTheme` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 2<br>10-desktop-bridge-tail.js 2 | 22 |
| `writeCustomTheme` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 2<br>10-desktop-bridge-tail.js 2 | 15 |
| `applyCustomTheme` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 2<br>10-desktop-bridge-tail.js 2 | 16 |
| `directAudioUrl` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 2<br>05-transport-transcript-nav.js 2 | 8 |
| `closeDrawer` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>05-transport-transcript-nav.js 3 | 10 |
| `openDetails` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 4<br>10-desktop-bridge-tail.js 2 | 9 |
| `closeOverlays` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3<br>10-desktop-bridge-tail.js 2 | 10 |
| `setImmersive` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 4<br>10-desktop-bridge-tail.js 2 | 10 |
| `wallpaperRefresh` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>09-player-integration.js 2 | 9 |
| `renderCues` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 3<br>05-transport-transcript-nav.js 4 | 14 |
| `updateTimeScale` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2<br>05-transport-transcript-nav.js 2 | 7 |
| `rawSeek` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 8<br>10-desktop-bridge-tail.js 3 | 15 |
| `syncLiveLeadSelect` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 2<br>07-routes-pages.js 2 | 7 |
| `liveMseStop` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 5<br>10-desktop-bridge-tail.js 2 | 12 |
| `liveUpdateMeter` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2<br>10-desktop-bridge-tail.js 2 | 8 |
| `applyLoudness` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 3<br>10-desktop-bridge-tail.js 3 | 9 |
| `ensureAudioGraph` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 4<br>10-desktop-bridge-tail.js 2 | 9 |
| `refreshOffline` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 4<br>10-desktop-bridge-tail.js 4 | 11 |
| `trNoteError` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 3<br>07-routes-pages.js 4 | 10 |
| `trReady` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 3<br>07-routes-pages.js 5 | 11 |
| `studyClockSeconds` | 03-native-asr-service-worker.js | 08-study-ai.js 3<br>10-desktop-bridge-tail.js 2 | 9 |
| `applySidebarCustomization` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4<br>08-study-ai.js 4 | 12 |
| `cleanWord` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4<br>10-desktop-bridge-tail.js 2 | 12 |
| `closeWordPanel` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4<br>10-desktop-bridge-tail.js 3 | 10 |
| `inboxCount` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>07-routes-pages.js 3 | 10 |
| `offlineEntries` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5<br>10-desktop-bridge-tail.js 2 | 10 |
| `parseRoute` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 6<br>07-routes-pages.js 3 | 12 |
| `syncRateSeg` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5<br>07-routes-pages.js 3 | 11 |
| `exportSubtitle` | 04-local-audio-plugin-host.js | 06-catalog-feeds-search.js 3<br>10-desktop-bridge-tail.js 2 | 9 |
| `loadLocalState` | 04-local-audio-plugin-host.js | 06-catalog-feeds-search.js 3<br>10-desktop-bridge-tail.js 2 | 8 |
| `TR` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5<br>07-routes-pages.js 26 | 35 |
| `applyRoute` | 04-local-audio-plugin-host.js | 07-routes-pages.js 3<br>10-desktop-bridge-tail.js 2 | 8 |
| `renderPage` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>07-routes-pages.js 5 | 12 |
| `syncTranslateSettings` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>07-routes-pages.js 5 | 12 |
| `trBatch` | 04-local-audio-plugin-host.js | 02-live-caption-wasm.js 2<br>07-routes-pages.js 5 | 10 |
| `trSave` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>07-routes-pages.js 3 | 9 |
| `openSettingsPane` | 04-local-audio-plugin-host.js | 08-study-ai.js 3<br>10-desktop-bridge-tail.js 3 | 12 |
| `openStudySheet` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>08-study-ai.js 4 | 10 |
| `wordCurrentMeaning` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5<br>10-desktop-bridge-tail.js 2 | 11 |
| `studyView` | 04-local-audio-plugin-host.js | 08-study-ai.js 4<br>10-desktop-bridge-tail.js 3 | 10 |
| `studyVocab` | 04-local-audio-plugin-host.js | 08-study-ai.js 5<br>10-desktop-bridge-tail.js 4 | 12 |
| `studyDueItems` | 04-local-audio-plugin-host.js | 08-study-ai.js 3<br>10-desktop-bridge-tail.js 2 | 8 |
| `studyOpenEpisodeSummary` | 04-local-audio-plugin-host.js | 08-study-ai.js 4<br>10-desktop-bridge-tail.js 2 | 9 |
| `syncStudySettings` | 04-local-audio-plugin-host.js | 07-routes-pages.js 3<br>08-study-ai.js 5 | 11 |
| `playEpisode` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4<br>10-desktop-bridge-tail.js 6 | 13 |
| `THEME_NAMES` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3<br>07-routes-pages.js 2 | 8 |
| `studyPluginOn` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 2<br>08-study-ai.js 2 | 11 |
| `pluginPlayerState` | 04-local-audio-plugin-host.js | 07-routes-pages.js 2<br>10-desktop-bridge-tail.js 5 | 13 |
| `refreshPluginSettings` | 04-local-audio-plugin-host.js | 07-routes-pages.js 2<br>10-desktop-bridge-tail.js 5 | 11 |
| `renderSearch` | 05-transport-transcript-nav.js | 07-routes-pages.js 4<br>10-desktop-bridge-tail.js 4 | 12 |
| `saveQueue` | 05-transport-transcript-nav.js | 07-routes-pages.js 4<br>10-desktop-bridge-tail.js 5 | 12 |
| `stepEpisode` | 05-transport-transcript-nav.js | 09-player-integration.js 3<br>10-desktop-bridge-tail.js 11 | 21 |
| `savePrefs` | 05-transport-transcript-nav.js | 08-study-ai.js 5<br>10-desktop-bridge-tail.js 14 | 28 |
| `dockSheet` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 1<br>10-desktop-bridge-tail.js 3 | 24 |
| `applyVolume` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2<br>10-desktop-bridge-tail.js 2 | 10 |
| `refreshAsrModels` | 05-transport-transcript-nav.js | 08-study-ai.js 2<br>10-desktop-bridge-tail.js 5 | 14 |
| `renderDownloads` | 05-transport-transcript-nav.js | 07-routes-pages.js 2<br>10-desktop-bridge-tail.js 2 | 8 |
| `renderOfflineList` | 05-transport-transcript-nav.js | 07-routes-pages.js 2<br>10-desktop-bridge-tail.js 2 | 10 |
| `PAGE_NAMES` | 05-transport-transcript-nav.js | 07-routes-pages.js 4<br>09-player-integration.js 2 | 9 |
| `syncIndexCount` | 05-transport-transcript-nav.js | 07-routes-pages.js 2<br>10-desktop-bridge-tail.js 3 | 13 |
| `normalizeFeedUrl` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2<br>10-desktop-bridge-tail.js 4 | 10 |
| `absoluteUrl` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2<br>10-desktop-bridge-tail.js 2 | 8 |
| `findBuiltinByFeed` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2<br>10-desktop-bridge-tail.js 3 | 8 |
| `saveSubs` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 3<br>10-desktop-bridge-tail.js 2 | 11 |
| `isFavorite` | 05-transport-transcript-nav.js | 07-routes-pages.js 3<br>10-desktop-bridge-tail.js 3 | 11 |
| `plainText` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2<br>07-routes-pages.js 4 | 9 |
| `normalizeSidebarPrefs` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2<br>08-study-ai.js 3 | 10 |
| `renderAfterStateChange` | 05-transport-transcript-nav.js | 07-routes-pages.js 2<br>10-desktop-bridge-tail.js 11 | 22 |
| `renderOnlineResults` | 06-catalog-feeds-search.js | 07-routes-pages.js 2<br>10-desktop-bridge-tail.js 2 | 11 |
| `searchTab` | 07-routes-pages.js | 05-transport-transcript-nav.js 2<br>10-desktop-bridge-tail.js 2 | 14 |
| `studyRegexEscape` | 00-kernel.js | 01-theme-reader-shell.js 3 | 5 |
| `registry` | 00-layers.js | 04-local-audio-plugin-host.js 2 | 6 |
| `need` | 00-layers.js | 02-live-caption-wasm.js 4 | 9 |
| `LIVE_FETCH` | 00-runtime.js | 02-live-caption-wasm.js 4 | 7 |
| `LIVE_BUDGET_MS` | 00-runtime.js | 02-live-caption-wasm.js 3 | 6 |
| `LIVE_SLICE` | 00-runtime.js | 02-live-caption-wasm.js 3 | 6 |
| `LIVE_TR_BATCH` | 00-runtime.js | 02-live-caption-wasm.js 2 | 5 |
| `liveAdvance` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 3 | 6 |
| `clipListen` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 4 | 7 |
| `localAsrAvailable` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 4 | 7 |
| `alignToCue` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3 | 6 |
| `lookupWord` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3 | 6 |
| `offlineKeyOf` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 4 | 7 |
| `placeFrame` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 5 | 8 |
| `syncDockLang` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 4 | 7 |
| `whenIdle` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3 | 7 |
| `shareCurrentCue` | 01-theme-reader-shell.js | 06-catalog-feeds-search.js 3 | 6 |
| `studyApplyWordMarks` | 01-theme-reader-shell.js | 08-study-ai.js 5 | 8 |
| `studyResetAutoPause` | 01-theme-reader-shell.js | 08-study-ai.js 3 | 6 |
| `PluginHost` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 35 | 38 |
| `themeBtns` | 01-theme-reader-shell.js | 08-study-ai.js 2 | 7 |
| `rememberOverlayTrigger` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 8 |
| `restoreOverlayFocus` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 8 |
| `REMOVED_THEME_FALLBACK` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 1 | 4 |
| `renderCustomThemeGrid` | 01-theme-reader-shell.js | 04-local-audio-plugin-host.js 2 | 14 |
| `closeTypeSheet` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3 | 13 |
| `resetImportUI` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 6 |
| `PROGRESS_KEY` | 01-theme-reader-shell.js | 10-desktop-bridge-tail.js 2 | 8 |
| `invalidateProgressCache` | 01-theme-reader-shell.js | 10-desktop-bridge-tail.js 2 | 5 |
| `progressAll` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 8 |
| `writeProgressAll` | 01-theme-reader-shell.js | 10-desktop-bridge-tail.js 2 | 7 |
| `progressKey` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 6 |
| `readProgress` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 5 |
| `clearProgress` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 5 |
| `preferredAudioUrl` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 3 | 7 |
| `onAudioError` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 5 |
| `openDrawer` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3 | 6 |
| `closeDetails` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 6 | 12 |
| `resetWordPanelForEpisode` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 5 |
| `invalidateWordPanelKey` | 01-theme-reader-shell.js | 09-player-integration.js 2 | 5 |
| `syncWallpaperPlay` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3 | 8 |
| `toggleWallpaperPlay` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 5 |
| `setWallpaper` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 4 | 8 |
| `sitePath` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 5 |
| `deriveZhUrl` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 5 |
| `deriveTimingsUrl` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 5 |
| `getText` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 3 | 6 |
| `transcriptMirror` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 6 |
| `vttFromSidecar` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 5 |
| `parseZhVTT` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 6 |
| `parseVttSmart` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 7 |
| `mergeCues` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 9 |
| `splitLabel` | 01-theme-reader-shell.js | 09-player-integration.js 2 | 7 |
| `alignZhLines` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 2 | 5 |
| `renderCueWindow` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 3 | 7 |
| `stopScroll` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 6 | 10 |
| `scrollCue` | 01-theme-reader-shell.js | 05-transport-transcript-nav.js 5 | 12 |
| `liveFollow` | 01-theme-reader-shell.js | 03-native-asr-service-worker.js 2 | 5 |
| `liveClearRows` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 7 | 10 |
| `liveNativeLoad` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 3 | 6 |
| `liveRebuildStream` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 9 | 14 |
| `liveRenderLine` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 8 | 12 |
| `CORE_PROVIDER_NAMES` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 2 | 7 |
| `registerCoreProvider` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 3 | 6 |
| `releaseCoreProviders` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 3 | 6 |
| `coreProviderOwner` | 02-live-caption-wasm.js | 04-local-audio-plugin-host.js 2 | 5 |
| `LIVE_ENGINE_KIND` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 7 |
| `liveMediaTime` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 1 | 4 |
| `liveMediaOf` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 8 | 11 |
| `clearLiveBarTimer` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 5 |
| `liveSetText` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 11 | 25 |
| `livePlayhead` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 8 |
| `liveRetry` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 3 | 6 |
| `liveProbeAudio` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 3 | 6 |
| `liveWaitAudioReady` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 5 |
| `liveMseCapable` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 3 | 7 |
| `liveMseBegin` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 3 | 7 |
| `liveMseReanchor` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 7 |
| `liveStartPump` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 5 |
| `liveStopPump` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 4 | 7 |
| `liveLoadEngine` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 5 |
| `liveEmitTokens` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 6 |
| `liveSherpaStream` | 02-live-caption-wasm.js | 03-native-asr-service-worker.js 2 | 5 |
| `openLocalTranscript` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 3 | 6 |
| `indexCurrentEpisode` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 3 | 6 |
| `loadChapters` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 3 | 6 |
| `readTranscriptDoc` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 4 | 7 |
| `saveOfflineTranscript` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 4 | 7 |
| `setAlignMode` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 7 | 10 |
| `trText` | 03-native-asr-service-worker.js | 07-routes-pages.js 3 | 6 |
| `updateDocumentTitle` | 03-native-asr-service-worker.js | 07-routes-pages.js 5 | 8 |
| `studyResetContext` | 03-native-asr-service-worker.js | 08-study-ai.js 3 | 6 |
| `liveWordTimes` | 03-native-asr-service-worker.js | 02-live-caption-wasm.js 1 | 5 |
| `liveEnable` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 2 | 5 |
| `liveFollowCurrentEpisode` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 1 | 8 |
| `applyEpisodeData` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 2 | 7 |
| `sanitizeAdRanges` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 3 | 7 |
| `mergeAdRanges` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 3 | 7 |
| `studyAdRangesFromData` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 2 | 6 |
| `studyApplyAiAdRanges` | 03-native-asr-service-worker.js | 04-local-audio-plugin-host.js 2 | 6 |
| `skipUrlOf` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 2 | 6 |
| `findSkipRange` | 03-native-asr-service-worker.js | 05-transport-transcript-nav.js 2 | 5 |
| `applyModules` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4 | 7 |
| `asrModelName` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5 | 11 |
| `bindModuleSwitches` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 3 | 6 |
| `copyPlain` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4 | 8 |
| `downloadInfo` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 5 | 8 |
| `downloadsHTML` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4 | 7 |
| `localAsrModelId` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 4 | 11 |
| `seekBy` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 8 | 12 |
| `loadCatalog` | 04-local-audio-plugin-host.js | 06-catalog-feeds-search.js 3 | 6 |
| `mergeCatalog` | 04-local-audio-plugin-host.js | 06-catalog-feeds-search.js 3 | 6 |
| `episodeRowHTML` | 04-local-audio-plugin-host.js | 07-routes-pages.js 6 | 9 |
| `podCardHTML` | 04-local-audio-plugin-host.js | 07-routes-pages.js 6 | 9 |
| `trNative` | 04-local-audio-plugin-host.js | 07-routes-pages.js 5 | 8 |
| `trStatus` | 04-local-audio-plugin-host.js | 07-routes-pages.js 8 | 11 |
| `applyStudyEngine` | 04-local-audio-plugin-host.js | 08-study-ai.js 3 | 9 |
| `applyStudyRuntime` | 04-local-audio-plugin-host.js | 08-study-ai.js 3 | 9 |
| `bindStudyUI` | 04-local-audio-plugin-host.js | 08-study-ai.js 4 | 7 |
| `studyAutoPause` | 04-local-audio-plugin-host.js | 08-study-ai.js 4 | 7 |
| `setStudyAutoPause` | 04-local-audio-plugin-host.js | 08-study-ai.js 3 | 6 |
| `setStudyView` | 04-local-audio-plugin-host.js | 08-study-ai.js 3 | 6 |
| `bindLedgerUI` | 04-local-audio-plugin-host.js | 09-player-integration.js 3 | 6 |
| `bindShell` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 3 | 6 |
| `startAutoRefresh` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 5 | 8 |
| `TR_CACHE` | 04-local-audio-plugin-host.js | 07-routes-pages.js 7 | 11 |
| `STUDY` | 04-local-audio-plugin-host.js | 08-study-ai.js 5 | 10 |
| `startLocalTranscribe` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 2 | 5 |
| `clipNow` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 2 | 8 |
| `renderList` | 04-local-audio-plugin-host.js | 05-transport-transcript-nav.js 2 | 11 |
| `PLUGIN_PAGES` | 04-local-audio-plugin-host.js | 07-routes-pages.js 2 | 8 |
| `destroyV2Page` | 04-local-audio-plugin-host.js | 07-routes-pages.js 2 | 6 |
| `renderV2Page` | 04-local-audio-plugin-host.js | 07-routes-pages.js 2 | 5 |
| `applySlotMounts` | 04-local-audio-plugin-host.js | 07-routes-pages.js 4 | 8 |
| `applySettingsPanes` | 04-local-audio-plugin-host.js | 08-study-ai.js 2 | 6 |
| `pluginReportError` | 04-local-audio-plugin-host.js | 07-routes-pages.js 2 | 23 |
| `pluginDiagnosticsText` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 2 | 4 |
| `registerStudyUiHook` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 6 | 9 |
| `studyUi` | 04-local-audio-plugin-host.js | 08-study-ai.js 9 | 13 |
| `studyRuntime` | 04-local-audio-plugin-host.js | 08-study-ai.js 21 | 25 |
| `studyEngine` | 04-local-audio-plugin-host.js | 08-study-ai.js 7 | 11 |
| `clearPluginConsent` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 2 | 6 |
| `reloadPlugins` | 04-local-audio-plugin-host.js | 10-desktop-bridge-tail.js 3 | 6 |
| `renderPluginPage` | 04-local-audio-plugin-host.js | 07-routes-pages.js 2 | 5 |
| `initPlayer` | 04-local-audio-plugin-host.js | player.js 2 | 5 |
| `feedKey` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 8 | 12 |
| `bindWordStatusButtons` | 05-transport-transcript-nav.js | 08-study-ai.js 4 | 8 |
| `wordStatusHTML` | 05-transport-transcript-nav.js | 08-study-ai.js 4 | 8 |
| `autoCleanup` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 4 | 7 |
| `closeModal` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 12 | 16 |
| `desktopNotify` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 5 | 8 |
| `playNextAuto` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 4 | 7 |
| `setSleep` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 4 | 8 |
| `applyRate` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 7 |
| `returnToCue` | 05-transport-transcript-nav.js | 07-routes-pages.js 2 | 7 |
| `framePos` | 05-transport-transcript-nav.js | 01-theme-reader-shell.js 5 | 14 |
| `seekChapter` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `toggleChapterSheet` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 4 | 9 |
| `playPlaylist` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `removePlaylist` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `addToPlaylistDialog` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `renderPlaylists` | 05-transport-transcript-nav.js | 07-routes-pages.js 2 | 5 |
| `renderLocalAsrModelHint` | 05-transport-transcript-nav.js | 08-study-ai.js 2 | 6 |
| `paintAsrSoon` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `installAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 6 |
| `cancelAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `openAsrDir` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `pickAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `removeAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `importAsrModel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `downloadEpisode` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 4 | 7 |
| `removeOffline` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 3 | 6 |
| `resolveOfflineRef` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 4 | 11 |
| `offlineLabel` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 3 | 7 |
| `playOffline` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `SUBS_KEY` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 3 | 7 |
| `AUTO_DEFAULTS` | 05-transport-transcript-nav.js | 06-catalog-feeds-search.js 2 | 5 |
| `SIDEBAR_META` | 05-transport-transcript-nav.js | 08-study-ai.js 2 | 6 |
| `idxGetAll` | 05-transport-transcript-nav.js | 07-routes-pages.js 2 | 6 |
| `idxClear` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `indexAllShows` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `indexCurrentShow` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `extSlug` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 4 | 7 |
| `subscribeShow` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 5 | 8 |
| `subscribeRecord` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 5 | 8 |
| `unsubscribeKey` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 3 | 6 |
| `saveFavorites` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 6 |
| `savePlayed` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 3 | 8 |
| `saveInbox` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 7 |
| `saveSeen` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `saveShowPrefs` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 6 |
| `setShowPref` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 6 | 9 |
| `toggleFavorite` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `setPlayed` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `addInboxItem` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 2 | 5 |
| `inboxRemove` | 05-transport-transcript-nav.js | 10-desktop-bridge-tail.js 3 | 6 |
| `episodeFilterMatch` | 05-transport-transcript-nav.js | 07-routes-pages.js 2 | 5 |
| `epStatusBadges` | 05-transport-transcript-nav.js | 07-routes-pages.js 2 | 5 |
| `fmtDuration` | 05-transport-transcript-nav.js | 07-routes-pages.js 5 | 8 |
| `routeModuleAllows` | 05-transport-transcript-nav.js | 07-routes-pages.js 2 | 9 |
| `sidebarOrder` | 05-transport-transcript-nav.js | 08-study-ai.js 3 | 7 |
| `firstShowKey` | 05-transport-transcript-nav.js | 07-routes-pages.js 2 | 5 |
| `addFeedFromUrl` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 5 | 8 |
| `startSleepTimer` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 4 | 7 |
| `feedCachePut` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 2 | 7 |
| `parseOpml` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 2 | 5 |
| `downloadFile` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 3 | 10 |
| `checkSubscriptions` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 2 | 5 |
| `stamp` | 06-catalog-feeds-search.js | 03-native-asr-service-worker.js 6 | 13 |
| `exportOpml` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 3 | 6 |
| `copyText` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 3 | 6 |
| `coverGrad` | 06-catalog-feeds-search.js | 09-player-integration.js 2 | 7 |
| `initialsOf` | 06-catalog-feeds-search.js | 09-player-integration.js 3 | 8 |
| `episodeCover` | 06-catalog-feeds-search.js | 07-routes-pages.js 7 | 10 |
| `ONLINE_PAGE` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 3 | 11 |
| `runOnlineSearch` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 5 | 8 |
| `openOnlineDetail` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 2 | 5 |
| `subscribeFromOnline` | 06-catalog-feeds-search.js | 10-desktop-bridge-tail.js 2 | 5 |
| `syncAutoNextSwitch` | 07-routes-pages.js | 10-desktop-bridge-tail.js 4 | 7 |
| `openPlayerRoute` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 6 |
| `renderHome` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 6 |
| `renderLibrary` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 6 |
| `renderDiscover` | 07-routes-pages.js | 10-desktop-bridge-tail.js 6 | 10 |
| `setSearchTab` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 5 |
| `renderLocal` | 07-routes-pages.js | 10-desktop-bridge-tail.js 3 | 8 |
| `importLocalFolder` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 5 |
| `renderPodcast` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 8 |
| `renderInbox` | 07-routes-pages.js | 10-desktop-bridge-tail.js 3 | 7 |
| `addToQueue` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 5 |
| `renderQueue` | 07-routes-pages.js | 10-desktop-bridge-tail.js 3 | 7 |
| `renderHistory` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 6 |
| `renderEcho` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 6 |
| `renderBookmarks` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 6 |
| `renderNotes` | 07-routes-pages.js | 10-desktop-bridge-tail.js 3 | 7 |
| `LISTEN_APPEARANCE` | 07-routes-pages.js | 10-desktop-bridge-tail.js 3 | 7 |
| `LISTEN_CONTINUE` | 07-routes-pages.js | 10-desktop-bridge-tail.js 3 | 7 |
| `renderAutoSettings` | 07-routes-pages.js | 10-desktop-bridge-tail.js 2 | 6 |
| `saveStudyCache` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 5 |
| `studyAddVocab` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 6 |
| `studyMarkWord` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 6 |
| `studyStats` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 5 |
| `studyExportCsv` | 08-study-ai.js | 10-desktop-bridge-tail.js 3 | 7 |
| `studyEpisodeHTML` | 08-study-ai.js | 10-desktop-bridge-tail.js 1 | 5 |
| `studyRenderEpisode` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 6 |
| `studyRenderPractice` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 6 |
| `studyLangName` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 5 |
| `studyReady` | 08-study-ai.js | 10-desktop-bridge-tail.js 3 | 6 |
| `studyChat` | 08-study-ai.js | 10-desktop-bridge-tail.js 3 | 6 |
| `studyParseJson` | 08-study-ai.js | 10-desktop-bridge-tail.js 3 | 6 |
| `studyCurrentCue` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 5 |
| `studyCueBounds` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 5 |
| `studyPlayRange` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 5 |
| `renderSidebarSettings` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 9 |
| `resetSidebarSettings` | 08-study-ai.js | 10-desktop-bridge-tail.js 2 | 5 |
| `toggleBookmarkCue` | 09-player-integration.js | 10-desktop-bridge-tail.js 2 | 5 |
| `currentPlaylist` | 09-player-integration.js | 10-desktop-bridge-tail.js 3 | 9 |
| `nextTarget` | 09-player-integration.js | 10-desktop-bridge-tail.js 2 | 6 |
| `toggleMiniCaption` | 09-player-integration.js | 10-desktop-bridge-tail.js 2 | 5 |
| `initXai` | 10-desktop-bridge-tail.js | player.js 2 | 4 |
