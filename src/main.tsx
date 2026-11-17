import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./app.css";

// A slideshow's presenter window loads this page at `#presenter` and gets that view alone, never the app.
const Presenter = React.lazy(() => import("./modules/excalidraw/Presenter"));
// The capture box's window loads it at `#capture` and gets the box alone (src/modules/capture).
const CaptureBox = React.lazy(() => import("./modules/capture/Box"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {location.hash === "#presenter" ? (
      <React.Suspense fallback={null}>
        <Presenter />
      </React.Suspense>
    ) : location.hash === "#capture" ? (
      <React.Suspense fallback={null}>
        <CaptureBox />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
