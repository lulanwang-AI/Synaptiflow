import { Routes, Route, Navigate } from "react-router-dom";
import NavBar from "./components/NavBar";
import { PersonaProvider } from "./lib/persona";
import LoopOverview from "./views/LoopOverview";
import Records from "./views/Records";
import Compound from "./views/Compound";
import Acquisition from "./views/Acquisition";
import MetricsView from "./views/Metrics";

export default function App() {
  return (
    <PersonaProvider>
      <NavBar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<LoopOverview />} />
          <Route path="/records" element={<Records />} />
          <Route path="/compound/:inchikey" element={<Compound />} />
          <Route path="/acquisition" element={<Acquisition />} />
          <Route path="/metrics" element={<MetricsView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </PersonaProvider>
  );
}
