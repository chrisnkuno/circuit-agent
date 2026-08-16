import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

// Outside StrictMode, not inside it: a boundary within StrictMode still catches, but placing it
// outermost means a throw from App's own module scope or from StrictMode's double-invoked render
// lands here too, rather than escaping to a blank window.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary version={__APP_VERSION__}>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </ErrorBoundary>,
);
