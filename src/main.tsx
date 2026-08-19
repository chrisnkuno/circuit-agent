import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TooltipProvider } from "./components/ui/tooltip";
import { bootTheme } from "./lib/theme";
import "./styles.css";

// Before the first render, not in an effect. A theme applied after React mounts is a theme applied
// one paint late, and that paint — a dark window flashing white, or the reverse — is the single
// clearest tell that a desktop app is a web page. `ThemeToggle` takes over from here and keeps
// following the machine for as long as the window is open.
bootTheme();

// Outside StrictMode, not inside it: a boundary within StrictMode still catches, but placing it
// outermost means a throw from App's own module scope or from StrictMode's double-invoked render
// lands here too, rather than escaping to a blank window.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary version={__APP_VERSION__}>
    <React.StrictMode>
      {/* One provider for the window: Radix shares the open/close timing across every tooltip, so
          moving between two toolbar buttons shows the second immediately instead of waiting out
          the delay again. */}
      <TooltipProvider delayDuration={400} skipDelayDuration={300}>
        <App />
      </TooltipProvider>
    </React.StrictMode>
  </ErrorBoundary>,
);
