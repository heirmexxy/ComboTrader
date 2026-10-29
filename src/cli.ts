// Command-line tools:
//   npm run seed                       demo data (local testing only)
//   npm run job -- <name>              run a scheduled job once (outbox, publish, lifecycle, prices, nudges, reconcile, weekly)
//   npm run backup -- [file]           consistent copy of the database
//   npm run make-admin -- <email> [roles]   give an existing account admin access (default role: super)
//   node dist/cli.mjs vapid            generate Web Push keys for .env
//   node dist/cli.mjs reset-2fa <email>   turn off two-step sign-in for an account that lost its authenticator
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
  case 'reset-2fa': {
    // Recovery when an admin loses their authenticator: switches 2FA off so they can sign in with the password and set it up again.
    const email = String(args[0] || '').toLowerCase();
    const r = q.run('UPDATE users SET totp_secret=NULL, totp_enabled=0 WHERE email=?', email);
    if (r.changes) q.run('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=?)', email);
    console.log(r.changes ? `Two-step sign-in is now OFF for ${email}. Sign in with the password, then set up the authenticator again in Security.` : `No account with email ${email}.`);
    break;
  }
  case 'time': console.log(`Server time (UTC): ${new Date().toISOString()}`); break;
  case 'vapid': {
    const k = generateVapidKeys();
    console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
    break;
  }
  default:
    console.log('Commands: seed | job <name> | backup [file] | make-admin <email> [roles] | reset-2fa <email> | time | vapid');
}
