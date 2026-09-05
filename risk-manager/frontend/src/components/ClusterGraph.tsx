import { useMemo } from 'react';
import type { SharedAttributeInfo } from '@risk-manager/shared';

/**
 * ClusterGraph — renders the abuse-ring cluster as a node-link SVG.
 * Accounts are nodes; shared attributes are attribute nodes connecting the
 * accounts that share them (the actual union-find graph the detector walks).
 * Layout: simple deterministic force simulation (no graph library needed for
 * a handful of nodes per cluster). Edge color/label by signal type.
 */

const SIGNAL_COLORS: Record<string, string> = {
  shared_device: '#dc2626',
  shared_phone: '#2563eb',
  shared_email: '#16a34a',
  shared_address: '#d97706',
  shared_payment_identifier: '#9333ea',
  shared_ip: '#0891b2',
};

const SIGNAL_LABELS: Record<string, string> = {
  shared_device: 'device',
  shared_phone: 'phone',
  shared_email: 'email',
  shared_address: 'address',
  shared_payment_identifier: 'payment id',
  shared_ip: 'IP',
};

interface Node {
  id: string;
  type: 'account' | 'attribute';
  signal?: string;
  x: number;
  y: number;
}

interface Link {
  source: string;
  target: string;
  signal: string;
}

export interface ClusterGraphProps {
  memberAccountIds: string[];
  sharedAttributes: SharedAttributeInfo[];
  anchorAccountId?: string;
  width?: number;
  height?: number;
}

/** Deterministic circular fallback when there are no shared attributes. */
function circularLayout(nodes: Node[], width: number, height: number): void {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.36;
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    n.x = cx + r * Math.cos(angle);
    n.y = cy + r * Math.sin(angle);
  });
}

/** Simple force-directed relaxation: accounts repel, links pull, center gravity. */
function forceLayout(nodes: Node[], links: Link[], width: number, height: number, iterations = 300): void {
  const cx = width / 2;
  const cy = height / 2;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Seed: circle positions (deterministic, avoids degenerate overlaps).
  circularLayout(nodes, width, height);

  const k = Math.sqrt((width * height) / Math.max(nodes.length, 1)) * 0.55; // ideal spacing

  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;

    // Repulsion between all node pairs (O(n^2), fine for <= ~30 nodes).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.01) {
          // deterministic nudge for exact overlaps
          dx = ((i * 7 + j * 13) % 10) / 10 - 0.5;
          dy = ((i * 11 + j * 3) % 10) / 10 - 0.5;
          dist = Math.sqrt(dx * dx + dy * dy) || 1;
        }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force * 0.02;
        const fy = (dy / dist) * force * 0.02;
        a.x -= fx;
        a.y -= fy;
        b.x += fx;
        b.y += fy;
      }
    }

    // Spring attraction along links.
    for (const link of links) {
      const a = byId.get(link.source);
      const b = byId.get(link.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - k) * 0.05;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.x += fx;
      a.y += fy;
      b.x -= fx;
      b.y -= fy;
    }

    // Gravity to center + damping, with cooling.
    for (const n of nodes) {
      n.x += (cx - n.x) * 0.01 * cooling;
      n.y += (cy - n.y) * 0.01 * cooling;
    }
  }

  // Clamp into view with padding.
  const pad = 34;
  for (const n of nodes) {
    n.x = Math.max(pad, Math.min(width - pad, n.x));
    n.y = Math.max(pad + 12, Math.min(height - pad, n.y));
  }
}

export default function ClusterGraph({
  memberAccountIds,
  sharedAttributes,
  anchorAccountId,
  width = 720,
  height = 460,
}: ClusterGraphProps) {
  const { nodes, links } = useMemo(() => {
    const accountNodes: Node[] = memberAccountIds.map((id) => ({
      id,
      type: 'account' as const,
      x: 0,
      y: 0,
    }));

    // Attribute nodes: one per unique (signal, value) — the shared hub.
    const attrKey = (signal: string, value: string) => `${signal}:${value}`;
    const attrMap = new Map<string, Node>();
    const builtLinks: Link[] = [];

    for (const attr of sharedAttributes) {
      const key = attrKey(attr.signal, attr.value);
      if (!attrMap.has(key)) {
        attrMap.set(key, { id: key, type: 'attribute', signal: attr.signal, x: 0, y: 0 });
      }
      builtLinks.push({ source: attr.account_id, target: key, signal: attr.signal });
    }

    const all = [...accountNodes, ...Array.from(attrMap.values())];
    forceLayout(all, builtLinks, width, height);
    return { nodes: all, links: builtLinks };
  }, [memberAccountIds, sharedAttributes, width, height]);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const usedSignals = Array.from(new Set(sharedAttributes.map((a) => a.signal)));

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full min-w-[560px]" role="img" aria-label="Abuse ring cluster graph">
        {/* Links */}
        {links.map((link, idx) => {
          const a = byId.get(link.source);
          const b = byId.get(link.target);
          if (!a || !b) return null;
          return (
            <line
              key={`link-${idx}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={SIGNAL_COLORS[link.signal] ?? '#94a3b8'}
              strokeWidth={1.6}
              strokeOpacity={0.55}
            />
          );
        })}

        {/* Attribute nodes (shared hubs) — diamond, colored by signal */}
        {nodes
          .filter((n) => n.type === 'attribute')
          .map((n) => (
            <g key={n.id}>
              <rect
                x={n.x - 5}
                y={n.y - 5}
                width={10}
                height={10}
                transform={`rotate(45 ${n.x} ${n.y})`}
                fill={SIGNAL_COLORS[n.signal ?? ''] ?? '#94a3b8'}
                fillOpacity={0.25}
                stroke={SIGNAL_COLORS[n.signal ?? ''] ?? '#94a3b8'}
                strokeWidth={1.4}
              />
              <title>{`${SIGNAL_LABELS[n.signal ?? ''] ?? n.signal}: ${n.id.split(':')[1]}`}</title>
            </g>
          ))}

        {/* Account nodes — circle; anchor highlighted */}
        {nodes
          .filter((n) => n.type === 'account')
          .map((n) => {
            const isAnchor = n.id === anchorAccountId;
            return (
              <g key={n.id}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={isAnchor ? 12 : 9}
                  fill={isAnchor ? '#7c3aed' : '#f8fafc'}
                  stroke={isAnchor ? '#4c1d95' : '#334155'}
                  strokeWidth={2}
                />
                <text
                  x={n.x}
                  y={n.y + 4}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={isAnchor ? 700 : 500}
                  fill={isAnchor ? '#ffffff' : '#0f172a'}
                >
                  {n.id.replace('acc_', '').slice(0, 4)}
                </text>
                <title>{isAnchor ? `${n.id} (anchor)` : n.id}</title>
              </g>
            );
          })}
      </svg>

      {/* Legend */}
      <div className="mt-3 px-6 pb-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">
        {usedSignals.map((signal) => (
          <span key={signal} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: SIGNAL_COLORS[signal] ?? '#94a3b8' }}
            />
            shared {SIGNAL_LABELS[signal] ?? signal}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-violet-600" />
          anchor account
        </span>
      </div>
    </div>
  );
}
