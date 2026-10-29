import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App.jsx";
import LocalPairing from './LocalPairing.jsx';

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LocalPairing><App /></LocalPairing>
  </React.StrictMode>,
);
