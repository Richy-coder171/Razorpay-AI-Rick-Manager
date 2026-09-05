/**
 * Agent Output Guard (§12) — deterministic, safety-critical.
 *
 * Checks, in order:
 *  1. schema validity (zod)
 *  2. calibrated_probability byte-equal to the detector's value
 *  3. confidence equal to the detector's confidence
 *  4. every evidence id exists in the detector output given to the LLM
 *  5. recommended_action is in the module's allowlist
 *
 * Every rejection short-circuits to escalation with a specific reason.
 * Deliberate adversarial unit tests try to sneak a wrong score, an invented
 * transaction id, and an out-of-enum action past this function (see
 * agentOutputGuard.test.ts) — all must be caught.
 */

import { z } from 'zod';
import { AgentOutput, AnyDetectorResult, ModuleName, MODULE_ACTION_ALLOWLIST } from '../../types';
import { AgentOutputSchema } from './provider';

export type GuardRejectionReason =
  | 'schema_invalid'
  | 'score_mismatch'
  | 'confidence_mismatch'
  | 'fabricated_evidence'
  | 'disallowed_action';

export interface GuardResult {
  accepted: boolean;
  reason?: GuardRejectionReason;
  detail?: string;
  output?: AgentOutput;
}

/** Collect all ids/field names that legitimately exist in the detector output. */
export function collectEvidenceIds(detectorOutput: AnyDetectorResult): Set<string> {
  const ids = new Set<string>();
  const walk = (obj: unknown, path: string[] = []) => {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, path);
      return;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const full = [...path, k].join('.');
        ids.add(full);
        if (typeof v === 'string' && (k.endsWith('_id') || k.endsWith('_ids') || k.endsWith('id'))) {
          ids.add(v);
        }
        walk(v, [...path, k]);
      }
    }
  };
  walk(detectorOutput);
  // Add top-level transaction ids for fraud spike windows.
  if ('affected_transaction_ids' in detectorOutput) {
    for (const id of detectorOutput.affected_transaction_ids) ids.add(id);
  }
  if ('member_account_ids' in detectorOutput) {
    for (const id of detectorOutput.member_account_ids) ids.add(id);
  }
  return ids;
}

export function validateAgentOutput(
  agentOutput: unknown,
  detectorOutput: AnyDetectorResult
): GuardResult {
  // 1. Schema
  const parsed = AgentOutputSchema.safeParse(agentOutput);
  if (!parsed.success) {
    return {
      accepted: false,
      reason: 'schema_invalid',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  const out = parsed.data;
  const module = detectorOutput.module;

  // 2. Score must be byte-for-byte equal to the detector's value.
  const detectorProb = round(detectorOutput.calibrated_probability);
  const agentProb = out.calibrated_probability === null ? null : round(out.calibrated_probability);
  const detectorProbRounded = detectorProb === null ? null : detectorProb;
  if (agentProb !== detectorProbRounded) {
    return {
      accepted: false,
      reason: 'score_mismatch',
      detail: `agent said ${agentProb}, detector said ${detectorProb}`,
    };
  }

  // 3. Confidence must equal the input confidence.
  if (out.confidence !== detectorOutput.confidence) {
    return {
      accepted: false,
      reason: 'confidence_mismatch',
      detail: `agent said ${out.confidence}, detector said ${detectorOutput.confidence}`,
    };
  }

  // 4. Every evidence id must exist in the detector output.
  const legit = collectEvidenceIds(detectorOutput);
  for (const id of out.evidence_cited) {
    if (!legit.has(id)) {
      return {
        accepted: false,
        reason: 'fabricated_evidence',
        detail: `cited evidence id "${id}" does not exist in detector output`,
      };
    }
  }

  // 5. Action must be in the module's allowlist.
  const allowlist = MODULE_ACTION_ALLOWLIST[module as ModuleName] || [];
  if (!allowlist.includes(out.recommended_action)) {
    return {
      accepted: false,
      reason: 'disallowed_action',
      detail: `"${out.recommended_action}" is not in the allowlist for ${module}: [${allowlist.join(', ')}]`,
    };
  }

  return { accepted: true, output: out };
}

/** Normalize numeric comparison for the byte-for-byte check (2dp detector rounding). */
function round(v: number | null): number | null {
  if (v === null || v === undefined) return null;
  return Math.round(v * 100) / 100;
}
