import { useState, useEffect } from 'react';
import {
  simulateNormal,
  simulateFraudSpike,
  simulateReturnRisk,
  simulateAbuseRing,
  simulateChargeback,
  simulateDetectorFailure,
  simulateInvalidData,
  simulateActionTimeout,
  createTestOrder,
  verifyCheckoutSignature,
  fetchVerifiedPayments,
} from '../services/api';
import type { DemoResponse, VerifiedPaymentInfo } from '../services/api';
import { PageHeader, Card, CardHeader, Badge, ModuleBadge, ConfidenceBadge, Button } from '../components/ui';
import { PlayIcon, SparkIcon } from '../components/icons';

const simulations = [
  { type: 'normal_traffic', label: 'Normal Traffic', variant: 'success' as const, fn: simulateNormal },
  { type: 'fraud_spike', label: 'Fraud Spike', variant: 'danger' as const, fn: simulateFraudSpike },
  { type: 'return_risk', label: 'Return Risk', variant: 'warning' as const, fn: simulateReturnRisk },
  { type: 'abuse_ring', label: 'Abuse Ring', variant: 'purple' as const, fn: simulateAbuseRing },
  { type: 'chargeback', label: 'Chargeback', variant: 'primary' as const, fn: simulateChargeback },
  { type: 'invalid_data', label: 'Invalid Data', variant: 'ghost' as const, fn: simulateInvalidData },
  { type: 'detector_failure', label: 'Detector Failure', variant: 'secondary' as const, fn: simulateDetectorFailure },
  { type: 'payment_timeout', label: 'Action Timeout', variant: 'secondary' as const, fn: simulateActionTimeout },
] as const;

export default function DemoMode() {
  const [results, setResults] = useState<DemoResponse[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [payStatus, setPayStatus] = useState<string | null>(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payments, setPayments] = useState<VerifiedPaymentInfo[]>([]);

  const loadPayments = async () => {
    try {
      setPayments(await fetchVerifiedPayments());
    } catch {
      // Provider not configured or backend unreachable — leave the list empty.
    }
  };

  useEffect(() => {
    loadPayments();
    // Poll while the page is open: a payment made in the Razorpay modal is
    // recorded by the WEBHOOK (which arrives asynchronously after checkout),
    // so the list updates automatically once Razorpay delivers it. Stops
    // when a new payment appears.
    const poll = setInterval(loadPayments, 4000);
    return () => clearInterval(poll);
  }, []);

  const runSimulation = async (type: string, simulator: () => Promise<DemoResponse>) => {
    setRunning(type);
    try {
      const result = await simulator();
      setResults((prev) => [result, ...prev].slice(0, 10));
    } catch (error) {
      console.error('Simulation failed:', error);
    } finally {
      setRunning(null);
    }
  };

  /** Load Razorpay's checkout.js on demand (never bundled; loaded from Razorpay's CDN). */
  const loadCheckoutScript = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (window.Razorpay) return resolve();
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('failed to load checkout.razorpay.com script'));
      document.body.appendChild(script);
    });

  /** Real ₹100 Razorpay Test Checkout: backend creates the order (keys stay server-side), Razorpay's modal runs the payment. */
  const payTest = async () => {
    setPayBusy(true);
    setPayStatus('Creating ₹100 order via the Razorpay Orders API…');
    try {
      const order = await createTestOrder();
      setPayStatus('Opening Razorpay Test Checkout…');
      await loadCheckoutScript();
      const checkout = new window.Razorpay!({
        key: order.key_id, // public key_id only — the key SECRET never reaches the browser
        amount: order.amount,
        currency: order.currency,
        order_id: order.id,
        name: 'Risk Manager Test',
        description: '₹100 Razorpay Test Mode payment (no real money moves)',
        handler: async (response) => {
          setPayStatus('Verifying checkout signature server-side…');
          try {
            const result = await verifyCheckoutSignature(
              response.razorpay_order_id,
              response.razorpay_payment_id,
              response.razorpay_signature
            );
            setPayStatus(
              result.verified
                ? `✓ Checkout signature verified (HMAC order_id|payment_id, server-side). Payment ${response.razorpay_payment_id} accepted — the signature-verified webhook will record it as a transaction.`
                : '✗ Checkout signature INVALID — payment not trusted.'
            );
            loadPayments();
          } catch (err) {
            setPayStatus(`Verification error: ${(err as Error).message}`);
          }
        },
        theme: { color: '#0b72e7' },
      });
      checkout.on('payment.failed', (e) => {
        setPayStatus(`payment failed: ${e.error?.description ?? e.description ?? 'unknown error'}`);
      });
      checkout.open();
    } catch (err) {
      setPayStatus(`Error: ${(err as Error).message}`);
    } finally {
      setPayBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Demo Mode"
        subtitle="One click per scenario — each runs the real pipeline end-to-end and lands in the audit log"
        badge={<Badge tone="yellow">FOR JUDGES</Badge>}
      />

      <Card>
        <CardHeader title="Run Simulations" subtitle="Fault-injection scenarios set real flags on real code paths" icon={<PlayIcon className="h-5 w-5" />} />
        <div className="px-6 pb-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {simulations.map((sim) => (
              <Button
                key={sim.type}
                variant={sim.variant}
                size="lg"
                disabled={running !== null}
                onClick={() => runSimulation(sim.type, sim.fn)}
                className="h-14"
              >
                {running === sim.type ? 'Running…' : sim.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Real Razorpay Test Checkout"
          subtitle="₹100 test-mode order via the real Orders API — checkout modal, server-side signature verification, webhook-verified recording"
        />
        <div className="px-6 pb-6 space-y-4">
          <Button variant="primary" size="lg" className="h-14 w-full md:w-auto" onClick={payTest} disabled={payBusy}>
            {payBusy ? 'Working…' : 'Pay ₹100 Test'}
          </Button>
          {payStatus && <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3 leading-relaxed">{payStatus}</p>}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-slate-700">Webhook-Verified Payments</h4>
              <button
                onClick={loadPayments}
                className="text-xs text-brand-700 hover:text-brand-900 font-medium"
                type="button"
              >
                ↻ Refresh
              </button>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              Recorded only after the Razorpay webhook's HMAC-SHA256 verifies over the raw body with
              RAZORPAY_WEBHOOK_SECRET (requires the webhook configured via a public tunnel — see README). Auto-refreshes every 4s.
            </p>
            {payments.length === 0 ? (
              <p className="text-slate-500 text-sm">None yet — complete a test payment with the webhook configured.</p>
            ) : (
              <div className="space-y-2">
                {payments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 text-sm bg-slate-50 rounded-lg px-3 py-2">
                    <span className="font-mono text-xs truncate">{p.id}</span>
                    <span className="shrink-0">₹{(p.amount / 100).toLocaleString('en-IN')}</span>
                    <span
                      className={`shrink-0 font-medium ${p.status === 'captured' ? 'text-emerald-700' : 'text-red-700'}`}
                    >
                      {p.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Pipeline" subtitle="Every simulation exercises the full chain" icon={<SparkIcon className="h-5 w-5" />} />
        <div className="px-6 pb-6">
          <div className="bg-slate-50 p-4 rounded-lg font-mono text-xs md:text-sm text-slate-700 overflow-x-auto">
            <pre>{`EVENT → FEATURES → DETECTOR → RISK SCORE → AI RISK MANAGER → OUTPUT GUARD → POLICY → ACTION / HUMAN ESCALATION → AUDIT LOG`}</pre>
          </div>
          <p className="mt-4 text-sm text-slate-600">
            Failures never throw: a failed detector skips the LLM entirely, a failed LLM falls back to a deterministic
            escalation, and a failed executor escalates after exactly one verified retry.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title={`Simulation Results ${results.length ? `(${results.length})` : ''}`} />
        <div className="px-6 pb-6">
          {results.length === 0 ? (
            <p className="text-slate-500 text-sm">No simulations run yet. Click a button above to start.</p>
          ) : (
            <div className="space-y-4">
              {results.map((result, idx) => (
                <div key={idx} className="border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <ModuleBadge module={result.detector?.module ?? 'fraud_spike'} />
                      <Badge tone={result.escalation?.required ? 'orange' : 'green'}>
                        {result.escalation?.required ? 'ESCALATED' : result.policy?.decision?.toUpperCase() ?? '—'}
                      </Badge>
                      {result.audit_id && <Badge tone="gray">audit {result.audit_id.slice(0, 8)}…</Badge>}
                    </div>
                    <span className="text-xs text-slate-400">{new Date().toLocaleTimeString()}</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div>
                      <span className="text-slate-500">Action:</span>{' '}
                      <span className="font-medium">{result.agent?.recommended_action ?? '—'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">Confidence:</span>
                      {result.agent && <ConfidenceBadge confidence={result.agent.confidence} />}
                    </div>
                    <div>
                      <span className="text-slate-500">Escalated:</span>{' '}
                      <span className={`font-medium ${result.escalation?.required ? 'text-orange-600' : 'text-slate-600'}`}>
                        {result.escalation?.required ? 'Yes' : 'No'}
                      </span>
                    </div>
                  </div>

                  {result.agent && (
                    <p className="text-sm text-slate-600 leading-relaxed">{result.agent.explanation}</p>
                  )}

                  {result.escalation?.reason && (
                    <p className="text-xs text-orange-700 bg-orange-50 rounded-lg px-3 py-2">
                      Escalation reason: {result.escalation.reason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
