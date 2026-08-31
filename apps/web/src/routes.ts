import type { FeatureFlag } from "./boundaries/featureFlags.ts";

export const workspaceRoutes = [
  { segment: "", label: "Home" },
  { segment: "projects", label: "Projects" },
  { segment: "files", label: "Files" },
  { segment: "jobs", label: "Jobs" },
] as const;

export const futureOutcomes = [
  {
    label: "Image & Graphic Studio",
    description: "Enhance, design and prepare visuals",
    publicDescription: "Review verified image facts before choosing visual work.",
    feature: "image-graphic-studio",
  },
  {
    label: "Create PDF",
    description: "Build PDFs from pages, images and rich content",
    publicDescription: "Review page-like sources before choosing how to build a PDF.",
    feature: "create-pdf",
  },
  {
    label: "Edit & Manage PDF",
    description: "Edit, organize, protect and convert PDFs",
    publicDescription: "Review a PDF safely before choosing page or document work.",
    feature: "edit-manage-pdf",
  },
  {
    label: "Print & Production",
    description: "Check quality and prepare production outputs",
    publicDescription: "Review source facts before selecting a digital or physical output path.",
    feature: "print-production",
  },
] as const satisfies ReadonlyArray<{ label: string; description: string; publicDescription: string; feature: FeatureFlag }>;

export function workspacePath(workspaceId: string, segment = ""): string {
  return `/w/${workspaceId}${segment ? `/${segment}` : ""}`;
}
