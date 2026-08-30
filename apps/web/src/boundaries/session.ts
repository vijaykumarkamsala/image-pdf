export interface SessionBoundary {
  status: "loading" | "signed_out" | "signed_in";
  workspaceId?: string;
}

export const loadingSession: SessionBoundary = { status: "loading" };
