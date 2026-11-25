/** Small client for the desk API (proxied under /api). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      // Required by the desk on every review action (a cross-site form cannot send it).
      ...(method !== "GET" ? { "x-hatchery-review": "1" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>("GET", path),
  post: <T,>(path: string, body: unknown) => request<T>("POST", path, body),
};

export type DefinitionStatus = "draft" | "approved" | "changes_requested";
export type Decision = "approve" | "request_changes" | "reject" | "comment";

export interface Me {
  name: string;
  role: "advisor" | "maintainer";
}

export interface DefinitionSummary {
  id: string;
  title: string;
  summary: string;
  path: string;
  requiresMathlib: boolean;
  status: DefinitionStatus;
  draft: boolean;
  draftReasons: string[];
}

export interface HistoryEntry {
  ts: string;
  decision: Decision;
  comment: string;
  reviewer: string;
  role: string;
}

export interface DefinitionDetail extends DefinitionSummary {
  source: string;
  sourceSha256: string;
  imports: { id: string; draft: boolean }[];
  declarations: { kind: string; name: string; doc: string; code: string }[];
  usedBy: { id: string; title: string; status: string }[];
  history: HistoryEntry[];
}

export interface StatementCheck {
  wellFormed: boolean;
  elaborates: boolean;
  trivial: boolean;
  trivialBy: string | null;
  errors: string[];
}

export interface StatementSummary {
  id: string;
  title: string;
  program: string;
  origin: string;
  leanStatement: string;
  check: StatementCheck | null;
  canApprove: boolean;
  approvalBlockers: string[];
}

export interface StatementDetail extends StatementSummary {
  programTitle: string;
  status: "proposed" | "approved" | "rejected";
  proposedBy: string;
  approvedBy: string | null;
  rationale: string;
  rejectReason: string | null;
  parentId: string | null;
  source: string;
  sourceSha256: string;
  definitions: { id: string; draft: boolean; reasons: string[] }[];
  usesDraftDefinition: boolean;
  lemmaStatus: string | null;
  history: HistoryEntry[];
}

export interface Queue {
  definitions: DefinitionSummary[];
  statements: StatementSummary[];
}
