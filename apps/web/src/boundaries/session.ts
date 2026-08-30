export interface SessionBoundary {
  readonly status: "guest" | "signed_out" | "signed_in";
  readonly workspaceId?: string;
}

export const guestSession: SessionBoundary = {
  status: "guest",
};
