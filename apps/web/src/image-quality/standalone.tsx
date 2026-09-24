import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import "../design-system/tokens.css";
import "../design-system/design-system.css";
import "../styles.css";
import { ImageQualityEditorPage } from "./ImageQualityEditorPage";

const root = document.getElementById("root");
if (!root) throw new Error("root element is missing");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/image-quality/*" element={<ImageQualityEditorPage />} />
        <Route path="*" element={<Navigate to="/image-quality" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
