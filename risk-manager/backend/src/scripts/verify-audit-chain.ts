/**
 * Chain verification CLI: `npm run verify-audit`
 * Walks the hash chain and reports whether the audit log is intact.
 */

import { AuditService } from '../audit';
import { createRepository } from '../models/repository';
import { AuditRecord } from '../types';
import { config } from '../config';

async function main() {
  const repo = createRepository<AuditRecord>('audit_log', 'audit-log.json');
  const service = new AuditService(repo);
  const result = await service.verifyChain();

  if (config.db_driver === 'file') {
    console.log(`driver: file (${config.data_dir})`);
  } else {
    console.log(`driver: mongo (${config.mongo_uri.replace(/\/\/[^@]+@/, '//***@')})`);
  }

  if (result.valid) {
    console.log(`VALID — ${result.records_checked} records, chain intact.`);
    process.exit(0);
  } else {
    console.error(`TAMPERED — chain broken after ${result.records_checked} records at ${result.broken_at}`);
    console.error(`reason: ${result.reason}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
