import React from "react";
import { createRoot } from "react-dom/client";
import Home from "./page";
import "./globals.css";

const container = document.getElementById("root");
if (!container) throw new Error("RepoLens renderer root is missing.");

createRoot(container).render(<React.StrictMode><Home /></React.StrictMode>);
