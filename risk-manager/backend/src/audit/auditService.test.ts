/**
 * Audit hash-chain tests (§16, §23).
 */

import { AuditService, GENESIS_HASH } from './auditService';
import { InMemoryRepository } from '../test-helpers';
import { JsonFileRepository } from '../models/repository';
import { AuditRecord } from '../types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Audit hash chain', () => {
  let repo: InMemoryRepository<AuditRecord>;
  let service: AuditService;

  beforeEach(() => {
    repo = new InMemoryRepository<AuditRecord>();
    service = new AuditService(repo);
  });

  it('chains records: first links to genesis, second links to first', async () => {
    const r1 = await service.log({ merchant_id: 'm1', module: 'fraud_spike', detector: 'd', input_reference: 'w1', detector_output: {}, recommended_action: 'no_action', policy_decision: 'approved', human_escalation: false, confidence: 'high', evidence_cited: [] });
    const r2 = await service.log({ merchant_id: 'm1', module: 'fraud_spike', detector: 'd', input_reference: 'w2', detector_output: {}, recommended_action: 'no_action', policy_decision: 'approved', human_escalation: false, confidence: 'high', evidence_cited: [] });

    expect(r1.prev_hash).toBe(GENESIS_HASH);
    expect(r2.prev_hash).toBe(r1.hash);
  });

  it('verifies an intact chain', async () => {
    for (let i = 0; i < 5; i++) {
      await service.log({ merchant_id: 'm1', module: 'fraud_spike', detector: 'd', input_reference: `w${i}`, detector_output: { i }, recommended_action: 'no_action', policy_decision: 'approved', human_escalation: false, confidence: 'high', evidence_cited: [] });
    }
    const result = await service.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.records_checked).toBe(5);
  });

  it('DETECTS tampering with record content (hash mismatch)', async () => {
    await service.log({ merchant_id: 'm1', module: 'fraud_spike', detector: 'd', input_reference: 'w1', detector_output: { note: 'original' }, recommended_action: 'no_action', policy_decision: 'approved', human_escalation: false, confidence: 'high', evidence_cited: [] });
    await service.log({ merchant_id: 'm1', module: 'fraud_spike', detector: 'd', input_reference: 'w2', detector_output: {}, recommended_action: 'no_action', policy_decision: 'approved', human_escalation: false, confidence: 'high', evidence_cited: [] });

    // Tamper: rewrite history via direct repo access (simulating an attacker).
    const all = await repo.findAll();
    const chrono = [...all].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    const victim = chrono.find((r: AuditRecord) => (r.detector_output as { note?: string }).note === 'original')!;
    (victim.detector_output as { note: string }).note = 'altered';
    await repo.rawWrite(chrono);

    const result = await service.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('modified');
  });

  it('DETECTS a broken prev_hash link', async () => {
    await service.log({ merchant_id: 'm1', module: 'x', detector: 'd', input_reference: 'w1', detector_output: {}, recommended_action: 'a', policy_decision: 'approved', human_escalation: false, confidence: 'high', evidence_cited: [] });
    await service.log({ merchant_id: 'm1', module: 'x', detector: 'd', input_reference: 'w2', detector_output: {}, recommended_action: 'a', policy_decision: 'approved', human_escalation: false, confidence: 'high', evidence_cited: [] });

    const all = await repo.findAll();
    all[0].prev_hash = 'f'.repeat(64); // attacker cuts the chain
    await (repo as { rawWrite?: (records: AuditRecord[]) => void }).rawWrite?.(all);

    const result = await service.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('prev_hash mismatch');
  });

  it('filters records by module/action/confidence/escalated/date', async () => {
    await service.log({ merchant_id: 'm', module: 'fraud_spike', detector: 'd', input_reference: 'a', detector_output: {}, recommended_action: 'no_action', policy_decision: 'approved', human_escalation: false, confidence: 'high', evidence_cited: [] });
    await service.log({ merchant_id: 'm', module: 'chargeback', detector: 'd', input_reference: 'b', detector_output: {}, recommended_action: 'draft_for_human_review', policy_decision: 'escalated', human_escalation: true, confidence: 'low', evidence_cited: [] });

    const escalated = await service.getRecords({ escalated: true });
    expect(escalated).toHaveLength(1);
    expect(escalated[0].module).toBe('chargeback');

    const byModule = await service.getRecords({ module: 'fraud_spike' });
    expect(byModule).toHaveLength(1);
  });

  it('REGRESSION: file-backed chain verifies after a JSON round-trip when optional fields are undefined', async () => {
    // The pipeline writes entries whose optional fields are explicitly
    // undefined (failure_state, guard_rejection_reason, …). stableStringify
    // once emitted "key":undefined for those, so the hash covered a string
    // JSON could never reproduce and EVERY file-backed record failed
    // verification after reload. This test pins the round-trip contract.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-audit-rt-'));
    const fileRepo = new JsonFileRepository<AuditRecord>('audit-log.json', dir);
    const fileService = new AuditService(fileRepo);

    await fileService.log({
      merchant_id: 'm1',
      module: 'fraud_spike',
      detector: 'fraud-spike-v2',
      input_reference: 'w1',
      detector_output: { nested: { value: 1, drop: undefined } },
      recommended_action: 'flag_for_review',
      policy_decision: 'escalated',
      human_escalation: true,
      confidence: 'medium',
      evidence_cited: ['module'],
      failure_state: undefined,
      guard_rejection_reason: undefined,
      idempotency_key: 'key_1',
    } as never);

    // Fresh repo instance => fresh cache loaded from DISK (round-trip happened).
    const reloaded = new AuditService(new JsonFileRepository<AuditRecord>('audit-log.json', dir));
    const result = await reloaded.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.records_checked).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('REGRESSION: stableStringify is round-trip canonical (undefined keys dropped like JSON does)', () => {
    // Direct unit pin on the primitive, independent of the service.
    const { stableStringify } = require('../utils/crypto');
    const original = { a: 1, b: undefined, c: { d: undefined, e: 'x' }, f: [1, undefined, 2] };
    const roundTripped = JSON.parse(JSON.stringify(original));
    expect(stableStringify(original)).toBe(stableStringify(roundTripped));
    expect(stableStringify(original)).not.toContain('undefined');
  });

  it('REGRESSION: computeHash excludes storage-internal keys (Mongo _id) so chains verify across drivers', async () => {
    const entry = {
      merchant_id: 'm1', module: 'fraud_spike', detector: 'd', input_reference: 'w1',
      detector_output: {}, recommended_action: 'flag_for_review', policy_decision: 'escalated',
      human_escalation: true, confidence: 'medium', evidence_cited: [],
    } as never;
    const written = await service.log(entry);
    // Simulate what MongoRepository does on read-back: Mongo injects _id into
    // the stored document. computeHash must ignore it or the chain breaks.
    const storedWithMongoId = { ...written, _id: '507f1f77bcf86cd799439011' };
    expect(service.computeHash(storedWithMongoId)).toBe(written.hash);
  });
});
