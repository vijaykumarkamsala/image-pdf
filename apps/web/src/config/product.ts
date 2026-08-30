interface ProductEnvironment {
  readonly VITE_PRODUCT_NAME?: string;
}

const environment = (import.meta as ImportMeta & { readonly env?: ProductEnvironment }).env;

export const productName = environment?.VITE_PRODUCT_NAME?.trim() || "Visual Workspace";
export const productMark = productName.trim().slice(0, 1).toUpperCase() || "V";
