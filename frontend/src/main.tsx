import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { maybeStartMock } from "./mocks/enable";

// Start the MSW mock backend if forced (VITE_USE_MOCK=1), toggled on at
// runtime, or the live backend is unreachable. Then mount the app.
async function bootstrap() {
  await maybeStartMock();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

void bootstrap();
