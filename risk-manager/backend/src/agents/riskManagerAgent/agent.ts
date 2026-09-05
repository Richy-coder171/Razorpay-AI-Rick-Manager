/**
 * Risk Manager Agent v2 (§11).
 *
 * Flow: detector output -> (failure_state? deterministic escalation, no LLM)
 * -> LLMProvider.complete with zero tools -> parse JSON -> Agent Output Guard.
 * Guard rejection => escalate with failure_state "agent_output_rejected".
 * LLM failure/timeout => MockProvider fallback (always escalates).
 */

import {
  AgentOutput,
  AnyDetectorResult,
  ConfidenceLevel,
  ModuleName,
  MODULE_ACTION_ALLOWLIST,
} from '../../types';
import { LLMProvider, MockProvider, getProvider } from './provider';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt';
import { validateAgentOutput, GuardResult } from './agentOutputGuard';

export interface AgentRunResult {
  agent_output: AgentOutput | null;
  guard: GuardResult;
  llm_used: 'gemini' | 'mock' | 'none';
  failure_state?: string;
}

const TOOL_NAMES: Record<ModuleName, string> = {
  fraud_spike: 'score_fraud_spike',
  return_risk: 'score_return_risk',
  abuse_ring: 'score_abuse_ring',
  chargeback: 'assess_chargeback',
};

export class RiskManagerAgent {
  private provider: LLMProvider;

  constructor(provider?: LLMProvider) {
    this.provider = provider || getProvider();
  }

  async run(detectorOutput: AnyDetectorResult, context?: Record<string, unknown>): Promise<AgentRunResult> {
    // §11: if a required detector field is missing or failure_state is set,
    // do not call the LLM at all — deterministic escalation.
    if (detectorOutput.failure_state) {
      return {
        agent_output: this.deterministicEscalation(detectorOutput, `detector reported failure_state=${detectorOutput.failure_state}`),
        guard: { accepted: true, output: undefined },
        llm_used: 'none',
        failure_state: detectorOutput.failure_state || undefined,
      };
    }

    const userPrompt = buildUserPrompt(detectorOutput, context);
    let raw: string;

    const isRealProvider = this.provider.name === 'gemini';
    let llmUsed: 'gemini' | 'mock' = isRealProvider ? 'gemini' : 'mock';

    try {
      raw = await this.provider.complete(SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      // §15: LLM failed -> deterministic rule-based fallback that always escalates.
      const mockProvider = isRealProvider ? new MockProvider() : this.provider;
      raw = await mockProvider.complete(SYSTEM_PROMPT, userPrompt);
      llmUsed = 'mock';
    }

    // Parse JSON out of the raw response (tolerate markdown fences).
    const candidate = extractJson(raw);
    if (candidate === null) {
      const fallback = this.deterministicEscalation(detectorOutput, 'LLM response was not parseable as JSON');
      return {
        agent_output: fallback,
        guard: { accepted: false, reason: 'schema_invalid', detail: 'unparseable LLM response' },
        llm_used: llmUsed,
        failure_state: 'agent_output_rejected',
      };
    }

    const guard = validateAgentOutput(candidate, detectorOutput);
    if (!guard.accepted) {
      return {
        agent_output: this.deterministicEscalation(detectorOutput, `Agent Output Guard rejected: ${guard.reason}`),
        guard,
        llm_used: llmUsed,
        failure_state: 'agent_output_rejected',
      };
    }

    return { agent_output: guard.output ?? null, guard, llm_used: llmUsed };
  }

  /**
   * Deterministic escalation (§15): a conservative AgentOutput that always
   * escalates. Used for detector failures, LLM failures, and guard rejections.
   */
  deterministicEscalation(detectorOutput: AnyDetectorResult, why: string): AgentOutput {
    const module = detectorOutput.module;
    return {
      module,
      tool_called: TOOL_NAMES[module],
      calibrated_probability:
        typeof detectorOutput.calibrated_probability === 'number' ? detectorOutput.calibrated_probability : null,
      recommended_action: conservativeAction(module),
      confidence: (detectorOutput.confidence as ConfidenceLevel) || 'low',
      escalate_to_human: true,
      explanation: `${why}. Deterministic escalation engaged: routed to human review. No score was invented; any numbers shown are copied from the detector output.`,
      evidence_cited: ['module', 'calibrated_probability', 'confidence'],
    };
  }
}

function conservativeAction(module: ModuleName): string {
  const allow = MODULE_ACTION_ALLOWLIST[module];
  switch (module) {
    case 'fraud_spike':
      return 'flag_for_review';
    case 'return_risk':
      return 'flag_for_manual_review';
    case 'abuse_ring':
      return 'flag_ring_for_investigation';
    case 'chargeback':
      return 'draft_for_human_review';
    default:
      return allow[allow.length - 1];
  }
}

function extractJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct !== null) return direct;

  // ```json ... ``` fenced
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const parsed = tryParse(fenceMatch[1].trim());
    if (parsed !== null) return parsed;
  }

  // first {...} block
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== null) return parsed;
  }

  return null;
}

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
