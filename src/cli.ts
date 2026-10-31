// Command-line tools:
//   npm run seed                       demo data (local testing only)
//   npm run job -- <name>              run a scheduled job once (outbox, publish, lifecycle, prices, nudges, reconcile, weekly)
//   npm run backup -- [file]           consistent copy of the database
//   npm run make-admin -- <email> [roles]   give an existing account admin access (default role: super)
//   node dist/cli.mjs vapid            generate Web Push keys for .env
process.env.NO_AUTOSTART = '1';
process.env.RUN_SCHEDULER = 'false';
import { openDb, q, rawDb } from './lib/db';
import { bootstrap } from './lib/bootstrap';
import { runJob } from './lib/jobs';
import { generateVapidKeys } from './lib/webpush';
import { seedDemo } from './seed';

const [cmd, ...args] = process.argv.slice(2);
openDb();
bootstrap();

switch (cmd) {
  case 'seed': {
    const r = seedDemo();
    console.log('Demo data loaded.');
    console.log(`  Admin:    ${r.admin.email} / ${r.admin.password}`);
    console.log(`  Champion: ${r.champion.email} / ${r.champion.password}`);
    break;
  }
  case 'job': console.log(await runJob(args[0])); break;
  case 'backup': {
    const file = args[0] || `data/backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    rawDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`Backup written to ${file}`);
    break;
  }
  case 'make-admin': {
    const r = q.run("UPDATE users SET role='admin', admin_roles=? WHERE email=?", args[1] || 'super', String(args[0] || '').toLowerCase());
    console.log(r.changes ? `${args[0]} is now an admin (${args[1] || 'super'}).` : `No account with email ${args[0]}. Sign up first, then run this again.`);
    break;
  }
  case 'test-email': {
    // Sends one email straight away and prints the provider's answer.
    const { sendEmail, emailShell } = await import('./lib/notify');
    const { config } = await import('./lib/config');
    if (!config.emailProvider || !config.emailApiKey) { console.log('Email is not set up: EMAIL_PROVIDER and EMAIL_API_KEY are needed in .env'); break; }
    try { await sendEmail(String(args[0]), 'ComboTrader test email', emailShell('It works', `<p>This test came from ${config.baseUrl} through ${config.emailProvider}, sent as ${config.emailFrom.replace(/</g, '&lt;')}.</p>`)); console.log(`Sent to ${args[0]} from ${config.emailFrom}. Check the inbox (and spam folder).`); }
    catch (e: any) { console.log(`Not sent: ${e.message}`); }
    break;
  }
  case 'clear-test-data': {
    if (args[0] !== '--yes') { console.log('This removes every Champion, lot, payment and trade (admins, settings and content stay). Run again with --yes to do it.'); break; }
    const { clearTestData } = await import('./lib/testmode');
    const r = clearTestData(null);
    console.log(`Test data cleared. ${r.counts.champions || 0} Champions removed. Backup: ${r.backup}`);
    break;
  }
  case 'time': console.log(`Server time (UTC): ${new Date().toISOString()}`); break;
  case 'vapid': {
    const k = generateVapidKeys();
    console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
    break;
  }
  default:
    console.log('Commands: seed | job <name> | backup [file] | make-admin <email> [roles] | test-email <to> | clear-test-data --yes | time | vapid');
}
