export type BundleStatus = 'pending' | 'approved' | 'committed';

export interface BundleSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly status: BundleStatus;
  readonly approval?: ApprovalInfo | null;
}

export interface ApprovalInfo {
  readonly actor: string;
  readonly policyVersion: string;
  readonly approvedAt: string;
}

export interface PlanIntentSummary {
  readonly id: string;
  readonly type: string;
  readonly timestamp?: string;
  readonly payload?: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface FileVersion {
  readonly isBinary: boolean;
  readonly text?: string;
}

export interface FileDiffEntry {
  readonly path: string;
  readonly before?: FileVersion;
  readonly after?: FileVersion;
}

export interface FileDiffSummary {
  readonly changed: FileDiffEntry[];
  readonly deleted: FileDiffEntry[];
}

export interface NetworkEntrySummary {
  readonly url: string;
  readonly method: string;
  readonly headers?: Record<string, string>;
}

export interface PolicyBundleDecision {
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reasons: string[];
}

export interface PolicyIntentDecision {
  readonly index: number;
  readonly type: string;
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reasons: string[];
  readonly approvalReasons: string[];
}

export interface PolicyNetworkDecision {
  readonly url: string;
  readonly method: string;
  readonly allowed: boolean;
  readonly reasons: string[];
}

export interface PolicyEvaluation {
  readonly policyVersion: string;
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reasons: string[];
  readonly bundle: PolicyBundleDecision;
  readonly intents: PolicyIntentDecision[];
  readonly network: PolicyNetworkDecision[];
}

export interface PromptRecord {
  readonly name: string;
  readonly content: string;
}

export interface PlanResponse {
  readonly bundleId: string;
  readonly createdAt: string;
  readonly intents: PlanIntentSummary[];
  readonly fsDiff: FileDiffSummary;
  readonly network: PolicyNetworkDecision[];
  readonly networkHar?: string | null;
  readonly policy: PolicyEvaluation;
  readonly approval?: ApprovalInfo | null;
  readonly prompts: PromptRecord[];
  readonly status: BundleStatus;
}

export interface UploadResponse {
  readonly bundleId: string;
}

export interface ActionResponse {
  readonly status: string;
  readonly bundleId: string;
}
