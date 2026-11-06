// The background worker: runs every scheduled job (emails, payment checks, agents, Adaeze, sequences, covers) in its
// own process, so a slow or stuck job can never take the website down. Started by combotrader-worker.service.
import { openDb, now } from './lib/db';
import { bootstrap } from './lib/bootstrap';
import { seedLibrary } from './lib/library';
import { startScheduler } from './lib/jobs';
import { replanMarketingQueue } from './lib/notify';
import { backfillCovers } from './lib/covers';
import { setSetting } from './lib/settings';
import { startStallGuard } from './lib/stallguard';
import { setupTelegramBot } from './lib/telegram';

openDb();
bootstrap();
try { seedLibrary(); } catch (e) { console.error('library seed failed', e); }
try { replanMarketingQueue(); } catch (e) { console.error('email re-plan failed', e); }
setTimeout(() => void backfillCovers(30).catch((e) => console.error('covers failed', e)), 60_000);
// Heartbeat: the website shows a warning (and emails super admins) if this stops for 10 minutes.
const beat = () => { try { setSetting('worker_heartbeat' as any, now()); } catch { /* the database is busy: next time */ } };
beat(); setInterval(beat, 30_000);
startScheduler();
// Telegram bot: point Telegram at our webhook and learn the bot's username.
setTimeout(() => void setupTelegramBot().then((r) => console.log(`Telegram bot: ${r}`)).catch((e) => console.error('Telegram bot setup failed:', e.message)), 10_000);
startStallGuard(10 * 60_000, 'background worker');
console.log('ComboTrader background worker running');
