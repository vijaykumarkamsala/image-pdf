export type FeatureFlag =
  | "web-shell"
  | "api-shell"
  | "processing-worker-shell"
  | "image-graphic-studio"
  | "create-pdf"
  | "edit-manage-pdf"
  | "print-production";

export interface ProductFeatureState {
  enabled(flag: FeatureFlag): boolean;
  showInactiveBuildIndicator: boolean;
}

export function createProductFeatureState(mode: string): ProductFeatureState {
  return {
    enabled(flag) {
      return flag === "web-shell";
    },
    showInactiveBuildIndicator: mode !== "production",
  };
}

const runtimeMode = (import.meta as ImportMeta & { readonly env?: { readonly MODE?: string } }).env?.MODE;

export const productFeatureState = createProductFeatureState(runtimeMode ?? "development");
