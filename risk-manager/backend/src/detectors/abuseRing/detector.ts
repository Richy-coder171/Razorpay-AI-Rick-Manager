/**
 * Abuse Ring Detector (§9, supporting module).
 *
 * Real graph: nodes = accounts + shared attribute values; edges = "shares this
 * attribute". Clusters found via union-find (connected components).
 * ring_score is a DETERMINISTIC, documented heuristic — not a trained model
 * (no reliable ground truth to train against; stated plainly in the README).
 *
 * Structural safety: a cluster is a lead, not a verdict. The AbuseRingAction
 * enum has no "ban" variant, so no code path can permanently ban anyone.
 */

import { LinkedAccount, AbuseRingResult, ConfidenceLevel, SharedAttributeInfo } from '../../types';

export const ABUSE_RING_DETECTOR_VERSION = 'abuse-ring-v2';

const SIGNAL_TYPES = [
  'shared_device',
  'shared_phone',
  'shared_email',
  'shared_address',
  'shared_payment_identifier',
  'shared_ip',
] as const;

type SignalType = (typeof SIGNAL_TYPES)[number];

interface GraphBuilderResult {
  parent: Map<string, string>;
  signalTypeCount: Map<string, Set<SignalType>>;
  clusterMembers: Map<string, Set<string>>;
  edgeCount: number;
}

function find(parent: Map<string, string>, x: string): string {
  let root = x;
  while (parent.get(root) !== root) {
    root = parent.get(root)!;
  }
  // Path compression.
  let cur = x;
  while (parent.get(cur) !== cur) {
    const next = parent.get(cur)!;
    parent.set(cur, root);
    cur = next;
  }
  return root;
}

function union(parent: Map<string, string>, a: string, b: string): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent.set(ra, rb);
}

function buildGraph(accounts: LinkedAccount[]): GraphBuilderResult {
  const parent = new Map<string, string>();
  const signalTypeCount = new Map<string, Set<SignalType>>();
  const clusterMembers = new Map<string, Set<string>>();
  const attrEdges: Array<{ account: string; signal: SignalType }> = [];

  const addNode = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };

  const link = (accountId: string, attributeNodeId: string, signal: SignalType) => {
    addNode(accountId);
    addNode(attributeNodeId);
    union(parent, accountId, attributeNodeId);
    attrEdges.push({ account: accountId, signal });
  };

  for (const acc of accounts) {
    addNode(acc.account_id);
    if (acc.shared_device_hash) link(acc.account_id, `device:${acc.shared_device_hash}`, 'shared_device');
    if (acc.shared_phone_hash) link(acc.account_id, `phone:${acc.shared_phone_hash}`, 'shared_phone');
    if (acc.shared_email_hash) link(acc.account_id, `email:${acc.shared_email_hash}`, 'shared_email');
    if (acc.shared_address_hash) link(acc.account_id, `address:${acc.shared_address_hash}`, 'shared_address');
    if (acc.shared_payment_identifier) link(acc.account_id, `payid:${acc.shared_payment_identifier}`, 'shared_payment_identifier');
    if (acc.shared_ip_hash) link(acc.account_id, `ip:${acc.shared_ip_hash}`, 'shared_ip');
  }

  // Second pass: attribute signals to FINAL roots (roots may have merged).
  for (const node of parent.keys()) signalTypeCount.set(node, new Set());
  for (const { account, signal } of attrEdges) {
    signalTypeCount.get(find(parent, account))!.add(signal);
  }

  // Cluster members = account nodes sharing a final root.
  for (const node of parent.keys()) {
    if (node.startsWith('acc_')) {
      const root = find(parent, node);
      if (!clusterMembers.has(root)) clusterMembers.set(root, new Set());
      clusterMembers.get(root)!.add(node);
    }
  }

  return { parent, signalTypeCount, clusterMembers, edgeCount: attrEdges.length };
}

export interface ClusterInfo {
  cluster_id: string;
  cluster_size: number;
  connecting_signals: string[];
  member_account_ids: string[];
  edge_density: number;
  distinct_signal_types: number;
  ring_score: number;
}

/**
 * Deterministic ring score (documented heuristic):
 *   ring_score = 0.5 * size_component + 0.3 * signal_diversity + 0.2 * edge_density
 * where size_component = min(cluster_size, 8)/8, signal_diversity = distinct_types/6,
 * edge_density = min(edges, size*(size-1)/2 max) normalized.
 */
export function computeRingScore(clusterSize: number, distinctSignals: number, edgeDensity: number): number {
  const sizeComponent = Math.min(clusterSize, 8) / 8;
  const signalDiversity = distinctSignals / SIGNAL_TYPES.length;
  const edgeComponent = Math.min(edgeDensity, 1);
  return round2(Math.min(1, 0.5 * sizeComponent + 0.3 * signalDiversity + 0.2 * edgeComponent));
}

function edgeDensity(clusterSize: number, edges: number): number {
  if (clusterSize <= 1) return 0;
  const maxEdges = (clusterSize * (clusterSize - 1)) / 2;
  return Math.min(1, edges / Math.max(maxEdges, 1));
}

export function findClusters(accounts: LinkedAccount[]): ClusterInfo[] {
  const graph = buildGraph(accounts);

  const clusters: ClusterInfo[] = [];
  for (const [root, members] of graph.clusterMembers) {
    if (members.size < 2) continue; // singletons are not rings

    const signals = graph.signalTypeCount.get(root) || new Set<SignalType>();
    // Intra-cluster edges: attribute links contributed by member accounts.
    let intraEdges = 0;
    for (const acc of accounts) {
      if (!members.has(acc.account_id)) continue;
      intraEdges += [
        acc.shared_device_hash,
        acc.shared_phone_hash,
        acc.shared_email_hash,
        acc.shared_address_hash,
        acc.shared_payment_identifier,
        acc.shared_ip_hash,
      ].filter(Boolean).length;
    }

    const density = edgeDensity(members.size, intraEdges);
    clusters.push({
      cluster_id: `cluster_${root.replace(/[^a-z0-9_]/gi, '').slice(-12)}`,
      cluster_size: members.size,
      connecting_signals: Array.from(signals).sort(),
      member_account_ids: Array.from(members).sort(),
      edge_density: round2(density),
      distinct_signal_types: signals.size,
      ring_score: computeRingScore(members.size, signals.size, density),
    });
  }

  return clusters.sort((a, b) => b.ring_score - a.ring_score);
}

/** Per-member shared attributes for a cluster — the graph edges (hashed values only). */
function sharedAttributesFor(accounts: LinkedAccount[], members: Set<string>): SharedAttributeInfo[] {
  const edges: SharedAttributeInfo[] = [];
  for (const acc of accounts) {
    if (!members.has(acc.account_id)) continue;
    if (acc.shared_device_hash) edges.push({ account_id: acc.account_id, signal: 'shared_device', value: acc.shared_device_hash });
    if (acc.shared_phone_hash) edges.push({ account_id: acc.account_id, signal: 'shared_phone', value: acc.shared_phone_hash });
    if (acc.shared_email_hash) edges.push({ account_id: acc.account_id, signal: 'shared_email', value: acc.shared_email_hash });
    if (acc.shared_address_hash) edges.push({ account_id: acc.account_id, signal: 'shared_address', value: acc.shared_address_hash });
    if (acc.shared_payment_identifier) edges.push({ account_id: acc.account_id, signal: 'shared_payment_identifier', value: acc.shared_payment_identifier });
    if (acc.shared_ip_hash) edges.push({ account_id: acc.account_id, signal: 'shared_ip', value: acc.shared_ip_hash });
  }
  return edges;
}

export function detectAbuseRing(
  merchantId: string,
  accounts: LinkedAccount[],
  anchorAccountId: string
): AbuseRingResult {
  const clusters = findClusters(accounts);
  const anchorCluster =
    clusters.find((c) => c.member_account_ids.includes(anchorAccountId)) || clusters[0];

  if (!anchorCluster) {
    return {
      module: 'abuse_ring',
      detector_version: ABUSE_RING_DETECTOR_VERSION,
      merchant_id: merchantId,
      ring_score: 0,
      cluster_id: 'cluster_none',
      cluster_size: 1,
      connecting_signals: [],
      member_account_ids: [anchorAccountId],
      edge_density: 0,
      calibrated_probability: 0,
      confidence: 'low',
      failure_state: 'insufficient_data',
    };
  }

  const probability = anchorCluster.ring_score; // rule-based score used directly
  const confidence: ConfidenceLevel = anchorCluster.cluster_size >= 4 && anchorCluster.distinct_signal_types >= 2 ? 'high' : anchorCluster.distinct_signal_types >= 1 ? 'medium' : 'low';

  // Graph edges for visualization: per-member shared attributes (hashed values).
  const memberSet = new Set(anchorCluster.member_account_ids);
  const sharedAttributes = sharedAttributesFor(accounts, memberSet);

  return {
    module: 'abuse_ring',
    detector_version: ABUSE_RING_DETECTOR_VERSION,
    merchant_id: merchantId,
    ring_score: anchorCluster.ring_score,
    cluster_id: anchorCluster.cluster_id,
    cluster_size: anchorCluster.cluster_size,
    connecting_signals: anchorCluster.connecting_signals,
    member_account_ids: anchorCluster.member_account_ids,
    edge_density: anchorCluster.edge_density,
    anchor_account_id: anchorAccountId,
    shared_attributes: sharedAttributes,
    calibrated_probability: probability,
    confidence,
    failure_state: null,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
