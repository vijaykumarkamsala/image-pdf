import { Layers3 } from "lucide-react";
import { productMark, productName } from "../config/product";

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="product-brand"><span className="product-mark" aria-hidden="true"><Layers3 /><span>{productMark}</span></span>{!compact && <span>{productName}</span>}</span>;
}
