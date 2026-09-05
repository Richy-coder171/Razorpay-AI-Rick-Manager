from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping


ACTION_SETS = {
    "fraud_spike": {"auto_block_window", "flag_for_review", "no_action"},
    "return_risk": {
        "allow_cod",
        "require_prepaid",
        "flag_for_manual_review",
        "block_order",
    },
    "abuse_ring": {
        "flag_ring_for_investigation",
        "restrict_accounts_pending_review",
        "no_action",
    },
    "chargeback": {
        "auto_contest_full",
        "auto_contest_partial",
        "draft_for_human_review",
        "recommend_accept_loss",
    },
}

MODULE_TO_TOOL = {
    "fraud_spike": "score_fraud_spike",
    "return_risk": "score_return_risk",
    "abuse_ring": "score_abuse_ring",
    "chargeback": "assess_chargeback",
}

REQUIRED_TOOL_FIELDS = {
    "fraud_spike": {
        "is_spike",
        "anomaly_score",
        "calibrated_probability",
        "affected_transaction_ids",
        "baseline",
    },
    "return_risk": {
        "calibrated_probability",
        "top_risk_factors",
        "similar_past_orders",
    },
    "abuse_ring": {
        "ring_score",
        "cluster_id",
        "cluster_size",
        "connecting_signals",
        "member_account_ids",
    },
    "chargeback": {
        "win_probability",
        "missing_evidence_types",
        "reason_code_base_rate",
        "days_until_deadline",
    },
}

IRREVERSIBLE_OR_MERCHANT_IMPACTING_ACTIONS = {
    "auto_block_window",
    "block_order",
    "restrict_accounts_pending_review",
    "recommend_accept_loss",
}

HUMAN_REVIEW_ACTIONS = {
    "flag_for_review",
    "flag_for_manual_review",
    "flag_ring_for_investigation",
    "draft_for_human_review",
}


class ToolNotRegisteredError(RuntimeError):
    """Raised when a requested loss class has no registered deterministic tool."""


@dataclass(frozen=True)
class PolicyThresholds:
    """Auto-action policy cutoffs.

    These values belong to code/config, not to generated explanations.
    """

    fraud_auto_block_window: float = 0.90
    return_require_prepaid: float = 0.65
    return_block_order: float = 0.92
    abuse_restrict_accounts_pending_review: float = 0.88
    chargeback_auto_contest_partial: float = 0.70
    chargeback_auto_contest_full: float = 0.85
    chargeback_recommend_accept_loss: float = 0.20


class RiskManagerOrchestrator:
    """Routes events to deterministic risk tools and formats audit JSON."""

    def __init__(
        self,
        tools: Mapping[str, Callable[..., Mapping[str, Any]]] | None = None,
        policy: PolicyThresholds | None = None,
    ) -> None:
        self._tools = dict(tools or {})
        self._policy = policy or PolicyThresholds()

    def handle(self, event: Mapping[str, Any]) -> dict[str, Any]:
        module = self._require_module(event)
        tool_name = MODULE_TO_TOOL[module]
        tool = self._tools.get(tool_name)

        if tool is None:
            raise ToolNotRegisteredError(
                f"{module} is not covered yet: {tool_name} is not registered. "
                "No risk opinion generated."
            )

        result = dict(tool(**self._tool_kwargs(module, event)))
        self._validate_tool_result(module, result)

        if module == "fraud_spike":
            return self._fraud_spike_decision(result)
        if module == "return_risk":
            return self._return_risk_decision(result, event)
        if module == "abuse_ring":
            return self._abuse_ring_decision(result)
        if module == "chargeback":
            return self._chargeback_decision(result)

        raise ValueError(f"Unsupported module: {module}")

    def handle_or_error(self, event: Mapping[str, Any]) -> dict[str, Any]:
        try:
            return self.handle(event)
        except ToolNotRegisteredError as exc:
            module = event.get("module")
            tool_called = MODULE_TO_TOOL.get(str(module), "")
            return {
                "module": module,
                "tool_called": tool_called,
                "error": str(exc),
            }

    def _require_module(self, event: Mapping[str, Any]) -> str:
        module = event.get("module")
        if module not in MODULE_TO_TOOL:
            allowed = ", ".join(sorted(MODULE_TO_TOOL))
            raise ValueError(f"module must be one of: {allowed}")
        return str(module)

    def _tool_kwargs(self, module: str, event: Mapping[str, Any]) -> dict[str, Any]:
        if module == "fraud_spike":
            return {
                "window_start": event["window_start"],
                "window_end": event["window_end"],
                "transactions": event["transactions"],
            }
        if module == "return_risk":
            return {
                "order_id": event["order_id"],
                "customer_id": event["customer_id"],
                "order_value": event["order_value"],
                "payment_mode": event["payment_mode"],
                "delivery_address": event["delivery_address"],
                "customer_history": event["customer_history"],
            }
        if module == "abuse_ring":
            return {
                "account_id": event["account_id"],
                "linked_accounts": event["linked_accounts"],
            }
        if module == "chargeback":
            return {
                "dispute_id": event["dispute_id"],
                "reason_code": event["reason_code"],
                "amount": event["amount"],
                "respond_by": event["respond_by"],
                "available_evidence": event["available_evidence"],
            }
        raise ValueError(f"Unsupported module: {module}")

    def _validate_tool_result(self, module: str, result: Mapping[str, Any]) -> None:
        missing = REQUIRED_TOOL_FIELDS[module] - set(result)
        if missing:
            fields = ", ".join(sorted(missing))
            raise ValueError(
                f"{MODULE_TO_TOOL[module]} returned an incomplete result. "
                f"Missing: {fields}. No risk opinion generated."
            )

    def _fraud_spike_decision(self, result: Mapping[str, Any]) -> dict[str, Any]:
        probability = _as_float(result["calibrated_probability"])
        confidence = _confidence_from_probability(probability)
        baseline = result["baseline"]
        affected_ids = list(result["affected_transaction_ids"])

        if not result["is_spike"]:
            action = "no_action"
        elif (
            confidence == "high"
            and probability >= self._policy.fraud_auto_block_window
        ):
            action = "auto_block_window"
        else:
            action = "flag_for_review"

        explanation = (
            f"Transaction volume in this {baseline['window_type']} window was "
            f"{result['anomaly_score']} standard deviations above the rolling "
            f"baseline of {baseline['mean']} (std {baseline['std']}), driven by "
            f"{len(affected_ids)} transactions ({_join_ids(affected_ids)}). "
        )
        if result["is_spike"]:
            explanation += "This is treated as a spike by the fraud-spike tool."
        else:
            explanation += "The fraud-spike tool did not mark this window as a spike."

        return self._decision(
            module="fraud_spike",
            tool_called="score_fraud_spike",
            calibrated_probability=probability,
            recommended_action=action,
            confidence=confidence,
            explanation=explanation,
            evidence_cited=[
                "is_spike",
                "anomaly_score",
                "baseline.mean",
                "baseline.std",
                "baseline.window_type",
                "affected_transaction_ids",
            ],
        )

    def _return_risk_decision(
        self,
        result: Mapping[str, Any],
        event: Mapping[str, Any],
    ) -> dict[str, Any]:
        probability = _as_float(result["calibrated_probability"])
        confidence = _confidence_from_probability(probability)
        payment_mode = str(event["payment_mode"]).upper()

        if probability >= self._policy.return_block_order and confidence == "high":
            action = "block_order"
        elif _is_ambiguous(probability):
            action = "flag_for_manual_review"
        elif payment_mode == "COD" and probability >= self._policy.return_require_prepaid:
            action = "require_prepaid"
        elif probability >= self._policy.return_require_prepaid:
            action = "flag_for_manual_review"
        else:
            action = "allow_cod"

        factors = list(result["top_risk_factors"])
        similar_orders = list(result["similar_past_orders"])
        explanation = (
            f"Return-risk probability is {probability:.2f} for this {payment_mode} "
            f"order. The top returned factors are {_join_ids(factors) or 'none'}, "
            f"and the tool returned {len(similar_orders)} similar past orders."
        )

        return self._decision(
            module="return_risk",
            tool_called="score_return_risk",
            calibrated_probability=probability,
            recommended_action=action,
            confidence=confidence,
            explanation=explanation,
            evidence_cited=[
                "calibrated_probability",
                "top_risk_factors",
                "similar_past_orders",
                "payment_mode",
            ],
        )

    def _abuse_ring_decision(self, result: Mapping[str, Any]) -> dict[str, Any]:
        ring_score = _as_float(result["ring_score"])
        confidence = _confidence_from_probability(ring_score)

        if (
            confidence == "high"
            and ring_score >= self._policy.abuse_restrict_accounts_pending_review
        ):
            action = "restrict_accounts_pending_review"
        elif ring_score > 0:
            action = "flag_ring_for_investigation"
        else:
            action = "no_action"

        signals = list(result["connecting_signals"])
        member_ids = list(result["member_account_ids"])
        explanation = (
            f"Abuse-ring score is {ring_score:.2f} for cluster "
            f"{result['cluster_id']} with {result['cluster_size']} accounts. "
            f"The returned connecting signals are {_join_ids(signals) or 'none'}, "
            f"and the member accounts returned are {_join_ids(member_ids) or 'none'}."
        )

        decision = self._decision(
            module="abuse_ring",
            tool_called="score_abuse_ring",
            calibrated_probability=None,
            recommended_action=action,
            confidence=confidence,
            explanation=explanation,
            evidence_cited=[
                "ring_score",
                "cluster_id",
                "cluster_size",
                "connecting_signals",
                "member_account_ids",
            ],
        )
        decision["ring_score"] = ring_score
        return decision

    def _chargeback_decision(self, result: Mapping[str, Any]) -> dict[str, Any]:
        win_probability = _as_float(result["win_probability"])
        confidence = _confidence_from_probability(win_probability)
        missing_evidence = list(result["missing_evidence_types"])

        if (
            confidence == "high"
            and not missing_evidence
            and win_probability >= self._policy.chargeback_auto_contest_full
        ):
            action = "auto_contest_full"
        elif (
            confidence == "high"
            and win_probability >= self._policy.chargeback_auto_contest_partial
        ):
            action = "auto_contest_partial"
        elif (
            confidence == "high"
            and win_probability <= self._policy.chargeback_recommend_accept_loss
        ):
            action = "recommend_accept_loss"
        else:
            action = "draft_for_human_review"

        explanation = (
            f"Estimated win probability is {win_probability:.2f}, compared with "
            f"this reason code's base rate of {result['reason_code_base_rate']}. "
            f"Missing evidence types are {_join_ids(missing_evidence) or 'none'}, "
            f"and there are {result['days_until_deadline']} days until the response "
            "deadline."
        )

        return self._decision(
            module="chargeback",
            tool_called="assess_chargeback",
            calibrated_probability=win_probability,
            recommended_action=action,
            confidence=confidence,
            explanation=explanation,
            evidence_cited=[
                "win_probability",
                "missing_evidence_types",
                "reason_code_base_rate",
                "days_until_deadline",
            ],
        )

    def _decision(
        self,
        *,
        module: str,
        tool_called: str,
        calibrated_probability: float | None,
        recommended_action: str,
        confidence: str,
        explanation: str,
        evidence_cited: list[str],
    ) -> dict[str, Any]:
        if recommended_action not in ACTION_SETS[module]:
            raise ValueError(
                f"{recommended_action} is not a bounded action for {module}"
            )

        score_for_ambiguity = calibrated_probability
        escalate = (
            confidence != "high"
            or recommended_action in IRREVERSIBLE_OR_MERCHANT_IMPACTING_ACTIONS
            or recommended_action in HUMAN_REVIEW_ACTIONS
            or (
                score_for_ambiguity is not None
                and _is_ambiguous(score_for_ambiguity)
            )
        )

        return {
            "module": module,
            "tool_called": tool_called,
            "calibrated_probability": calibrated_probability,
            "recommended_action": recommended_action,
            "confidence": confidence,
            "escalate_to_human": escalate,
            "explanation": explanation,
            "evidence_cited": evidence_cited,
        }


def _as_float(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Expected numeric tool score, got {value!r}")
    return float(value)


def _confidence_from_probability(probability: float) -> str:
    if not 0 <= probability <= 1:
        raise ValueError(f"Probability-like score must be between 0 and 1: {probability}")
    if _is_ambiguous(probability):
        return "low"
    if probability >= 0.80 or probability <= 0.20:
        return "high"
    return "medium"


def _is_ambiguous(probability: float) -> bool:
    return 0.40 <= probability <= 0.60


def _join_ids(values: list[Any]) -> str:
    return ", ".join(str(value) for value in values)
