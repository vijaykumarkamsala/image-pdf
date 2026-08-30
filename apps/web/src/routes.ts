import type { FeatureFlag } from "./boundaries/featureFlags.ts";

export const workspaceRoutes = [
  { segment: "", label: "Home" },
  { segment: "projects", label: "Projects" },
  { segment: "files", label: "Files" },
] as const;

export const futureOutcomes = [
  {
    label: "Image & Graphic Studio",
    description: "Enhance, design and prepare visuals",
    feature: "image-graphic-studio",
  },
  {
    label: "Create PDF",
    description: "Build PDFs from pages, images and rich content",
    feature: "create-pdf",
  },
  {
    label: "Edit & Manage PDF",
    description: "Edit, organize, protect and convert PDFs",
    feature: "edit-manage-pdf",
  },
  {
    label: "Print & Production",
    description: "Check quality and prepare production outputs",
    feature: "print-production",
  },
] as const satisfies ReadonlyArray<{ label: string; description: string; feature: FeatureFlag }>;

export function workspacePath(workspaceId: string, segment = ""): string {
  return `/w/${workspaceId}${segment ? `/${segment}` : ""}`;
}
