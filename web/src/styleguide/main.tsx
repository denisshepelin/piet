import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Styleguide } from "./Styleguide.tsx";
import "../index.css";
import "../canvasTheme.css";
import "./styleguide.css";

const root = document.getElementById("root");

if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <Styleguide />
  </StrictMode>,
);
