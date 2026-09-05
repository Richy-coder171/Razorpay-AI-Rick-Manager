/**
 * LLM Provider interface (§11). The LLM is a PURE FUNCTION: structured facts
 * in, structured opinion out. Zero tools, zero function-calling definitions,
 * zero database/payment access. OpenRouterProvider for the real call (any
 * model on openrouter.ai, free-tier default), MockProvider as the
 * deterministic rule-based fallback used when the key is unset or the call
 * fails/times out — the fallback ALWAYS escalates, so a dead LLM degrades
 * safety margin rather than removing safety (§15).
 */

import { z } from 'zod';
import { AgentOutput, ConfidenceLevel, ModuleName, MODULE_ACTION_ALLOWLIST } from '../../types';
import { config } from '../../config';
import logger from '../../utils/logger';

export const AgentOutputSchema = z.object({
  module: z.enum(['fraud_spike', 'return_risk', 'abuse_ring', 'chargeback']),
  tool_called: z.string(),
  calibrated_probability: z.number().nullable(),
  recommended_action: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  escalate_to_human: z.boolean(),
  explanation: z.string().min(1).max(2000),
  evidence_cited: z.array(z.string()),
}) satisfies z.ZodType<AgentOutput>;

export interface LLMProvider {
  readonly name: string;
  /** Send [system, user] messages; receive raw text. MUST be side-effect free. */
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

/**
 * OpenRouter provider — plain HTTPS call to the OpenAI-compatible
 * /api/v1/chat/completions endpoint (no SDK dependency). The API key is read
 * from config (OPENROUTER_API_KEY env var) and is NEVER hardcoded.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.llm_timeout_ms);

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.openrouter_api_key}`,
          'Content-Type': 'application/json',
          // Optional OpenRouter attribution headers (app ranking metadata only).
          'X-OpenRouter-Title': 'Risk Manager',
        },
        body: JSON.stringify({
          model: config.openrouter_model,
          max_tokens: 1024,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`OpenRouter API error ${response.status}: ${body.slice(0, 300)}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = payload.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error('OpenRouter returned an empty completion');

      logger.info({ model: config.openrouter_model, chars: text.length }, 'openrouter response received');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Deterministic rule-based fallback. Used when OPENROUTER_API_KEY is unset or
 * the call fails/times out. Always conservative: escalate, low confidence.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    // Echo back a conservative JSON derived from the detector payload embedded
    // in the user prompt. The Agent's rule-based path will recompute this
    // deterministically; the provider just returns parseable JSON.
    const detectorJson = extractDetectorJson(userPrompt);
    const module = (detectorJson?.module as ModuleName) || 'fraud_spike';
    const probability = typeof detectorJson?.calibrated_probability === 'number' ? detectorJson.calibrated_probability : null;
    const confidence = (detectorJson?.confidence as ConfidenceLevel) || 'low';
    const allowed = MODULE_ACTION_ALLOWLIST[module] || ['no_action'];
    const action = module === 'fraud_spike' ? 'flag_for_review' : allowed[Math.min(1, allowed.length - 1)];

    return JSON.stringify({
      module,
      tool_called: `score_${module}`,
      calibrated_probability: probability,
      recommended_action: module === 'fraud_spike' ? 'flag_for_review' : action,
      confidence,
      escalate_to_human: true,
      explanation:
        'LLM provider unavailable — deterministic conservative fallback engaged. Every number in this output originates from the detector payload; no scores are invented. Escalated to human review as the safe default.',
      evidence_cited: ['calibrated_probability', 'confidence', 'module'],
    });
  }
}

function extractDetectorJson(userPrompt: string): Record<string, unknown> | null {
  // The agent embeds the detector JSON between explicit DATA markers.
  const markerStart = userPrompt.indexOf('<<<DETECTOR_OUTPUT>>>');
  const markerEnd = userPrompt.indexOf('<<<END_DETECTOR_OUTPUT>>>');
  if (markerStart === -1 || markerEnd === -1) return null;
  const start = userPrompt.indexOf('{', markerStart);
  if (start === -1 || start > markerEnd) return null;
  try {
    return JSON.parse(userPrompt.slice(start, markerEnd).trim());
  } catch {
    return null;
  }
}

export function getProvider(): LLMProvider {
  if (config.llm_provider === 'openrouter' && config.openrouter_api_key) {
    return new OpenRouterProvider();
  }
  return new MockProvider();
}
