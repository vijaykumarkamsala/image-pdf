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
    publicDescription: "Inspect images and prepare a trustworthy path for design or production.",
    feature: "image-graphic-studio",
  },
  {
    label: "Create PDF",
    description: "Build PDFs from pages, images and rich content",
    publicDescription: "Bring pages and images together in one future editable document workspace.",
    feature: "create-pdf",
  },
  {
    label: "Edit & Manage PDF",
    description: "Edit, organize, protect and convert PDFs",
    publicDescription: "Inspect a PDF safely before choosing page or document work.",
    feature: "edit-manage-pdf",
  },
  {
    label: "Print & Production",
    description: "Check quality and prepare production outputs",
    publicDescription: "Understand source facts before selecting a digital or physical output path.",
    feature: "print-production",
  },
] as const satisfies ReadonlyArray<{ label: string; description: string; publicDescription: string; feature: FeatureFlag }>;

export function workspacePath(workspaceId: string, segment = ""): string {
  return `/w/${workspaceId}${segment ? `/${segment}` : ""}`;
}
