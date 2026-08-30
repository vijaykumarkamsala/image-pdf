import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { registerServiceWorker } from "./pwa/serviceWorker";
import "./design-system/tokens.css";
import "./design-system/design-system.css";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("root element is missing");
}

void registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
