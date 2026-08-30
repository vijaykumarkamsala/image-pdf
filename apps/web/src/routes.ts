export const workspaceRoutes = [
  { segment: "", label: "Home" },
  { segment: "projects", label: "Projects" },
  { segment: "files", label: "Files" },
] as const;

export const futureOutcomes = [
  "Image & Graphic Studio",
  "Create PDF",
  "Edit & Manage PDF",
  "Print & Production",
] as const;

export function workspacePath(workspaceId: string, segment = ""): string {
  return `/w/${workspaceId}${segment ? `/${segment}` : ""}`;
}
