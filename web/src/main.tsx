/**
 * main.tsx — the React entry for the harness-workflow single-page application.
 *
 * Mounts the app shell into the Vite root index document's #root element and
 * imports the Tailwind entry stylesheet. The server serves the built output
 * (web/dist) produced from this entry (ticket #31).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

const root = document.getElementById("root");
if (root === null) {
	throw new Error("harness-workflow: missing #root mount element");
}

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
