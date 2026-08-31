interface ProductEnvironment {
  readonly VITE_PRODUCT_NAME?: string;
}

const environment = (import.meta as ImportMeta & { readonly env?: ProductEnvironment }).env;

export const DEFAULT_PRODUCT_NAME = "Visual Workspace";

export function resolveProductName(value?: string): string {
  return value?.trim().slice(0, 64) || DEFAULT_PRODUCT_NAME;
}

export function renderProductTemplate(template: string, name: string): string {
  const safeName = resolveProductName(name)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return template.replaceAll("{{PRODUCT_NAME}}", safeName);
}

export const productName = resolveProductName(environment?.VITE_PRODUCT_NAME);
export const productMark = productName.trim().slice(0, 1).toUpperCase() || "V";
