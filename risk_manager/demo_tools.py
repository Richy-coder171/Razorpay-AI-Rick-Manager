from __future__ import annotations

from datetime import date
from statistics import mean, pstdev
from typing import Any, Mapping


def score_fraud_spike(
    window_start: str,
    window_end: str,
    transactions: list[Mapping[str, Any]],
) -> dict[str, Any]:
    """Deterministic demo fraud-spike scorer.

    The current window count is compared against historical window counts carried
    on the input transactions under historical_window_count.
    """

    historical_counts = [
        int(tx["historical_window_count"])
        for tx in transactions
        if "historical_window_count" in tx
    ]
    current_ids = [
        str(tx["id"])
        for tx in transactions
        if window_start <= str(tx.get("created_at", "")) < window_end
    ]

    if historical_counts:
        baseline_mean = mean(historical_counts)
        baseline_std = pstdev(historical_counts) or 1.0
    else:
        baseline_mean = 0.0
        baseline_std = 1.0

    anomaly_score = (len(current_ids) - baseline_mean) / baseline_std
    calibrated_probability = _clamp((anomaly_score - 1.0) / 4.0)

    return {
        "is_spike": anomaly_score >= 3.0,
        "anomaly_score": round(anomaly_score, 2),
        "calibrated_probability": round(calibrated_probability, 2),
        "affected_transaction_ids": current_ids,
        "baseline": {
            "mean": round(baseline_mean, 2),
            "std": round(baseline_std, 2),
            "window_type": "configured",
        },
    }


def score_return_risk(
    order_id: str,
    customer_id: str,
    order_value: float,
    payment_mode: str,
    delivery_address: Mapping[str, Any],
    customer_history: Mapping[str, Any],
) -> dict[str, Any]:
    """Deterministic demo return-risk scorer."""

    del order_id, customer_id
    factors: list[str] = []
    score = 0.10

    if payment_mode.upper() == "COD":
        score += 0.25
        factors.append("cod_payment")
    if order_value >= 5000:
        score += 0.18
        factors.append("high_order_value")
    if customer_history.get("prior_returns", 0) >= 2:
        score += 0.25
        factors.append("repeat_return_history")
    if customer_history.get("failed_deliveries", 0) >= 1:
        score += 0.12
        factors.append("prior_failed_delivery")
    if delivery_address.get("serviceability") == "low":
        score += 0.10
        factors.append("low_serviceability_address")

    return {
        "calibrated_probability": round(_clamp(score), 2),
        "top_risk_factors": factors[:3],
        "similar_past_orders": list(customer_history.get("similar_past_orders", [])),
    }


def score_abuse_ring(
    account_id: str,
    linked_accounts: list[Mapping[str, Any]],
) -> dict[str, Any]:
    """Deterministic demo abuse-ring scorer."""

    member_ids = [account_id]
    signals: set[str] = set()
    score = 0.0

    for account in linked_accounts:
        if account.get("shared_device_id"):
            score += 0.22
            signals.add("shared_device_id")
        if account.get("shared_bank_account"):
            score += 0.28
            signals.add("shared_bank_account")
        if account.get("shared_delivery_address"):
            score += 0.18
            signals.add("shared_delivery_address")
        if account.get("chargeback_count", 0) >= 2:
            score += 0.14
            signals.add("repeat_chargebacks")
        member_ids.append(str(account["account_id"]))

    cluster_size = len(member_ids)
    if cluster_size >= 4:
        score += 0.12
        signals.add("cluster_size")

    return {
        "ring_score": round(_clamp(score), 2),
        "cluster_id": f"cluster_{account_id}",
        "cluster_size": cluster_size,
        "connecting_signals": sorted(signals),
        "member_account_ids": member_ids,
    }


def assess_chargeback(
    dispute_id: str,
    reason_code: str,
    amount: float,
    respond_by: str,
    available_evidence: list[str],
) -> dict[str, Any]:
    """Deterministic demo chargeback assessor."""

    del dispute_id, amount
    required_by_reason = {
        "product_not_received": ["proof_of_delivery", "customer_communication"],
        "service_not_provided": ["proof_of_service", "customer_communication"],
        "fraudulent": ["avs_match", "device_fingerprint", "delivery_confirmation"],
    }
    base_rates = {
        "product_not_received": 0.46,
        "service_not_provided": 0.42,
        "fraudulent": 0.35,
    }
    required = required_by_reason.get(reason_code, ["proof_of_service"])
    missing = [item for item in required if item not in available_evidence]
    evidence_ratio = (len(required) - len(missing)) / max(len(required), 1)
    base_rate = base_rates.get(reason_code, 0.40)
    win_probability = _clamp(base_rate + (evidence_ratio - 0.5) * 0.45)

    return {
        "win_probability": round(win_probability, 2),
        "missing_evidence_types": missing,
        "reason_code_base_rate": base_rate,
        "days_until_deadline": _days_until_deadline(respond_by),
    }


def demo_tools() -> dict[str, Any]:
    return {
        "score_fraud_spike": score_fraud_spike,
        "score_return_risk": score_return_risk,
        "score_abuse_ring": score_abuse_ring,
        "assess_chargeback": assess_chargeback,
    }


def _days_until_deadline(respond_by: str) -> int:
    deadline = date.fromisoformat(respond_by)
    return (deadline - date.today()).days


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))
