/* player 入口：按层导入，所有跨分片依赖都由模块 import 显式声明。
   这里只保留启动顺序，不再把 10 个分片拼进同一个 IIFE。 */
import './00-kernel.js';
import './00-runtime.js';
import './01-theme-reader-shell.js';
import './02-live-caption-wasm.js';
import './03-native-asr-service-worker.js';
import './04-local-audio-plugin-host.js';
import './05-transport-transcript-nav.js';
import './06-catalog-feeds-search.js';
import './07-routes-pages.js';
import './08-study-ai.js';
import './09-player-integration.js';
import './10-desktop-bridge-tail.js';
import './11-motion.js';
import { initPlayer } from './04-local-audio-plugin-host.js';
import { initXai } from './10-desktop-bridge-tail.js';

initPlayer();
initXai();
