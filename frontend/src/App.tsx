import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import NavBar from "./components/NavBar";
import { PersonaProvider } from "./lib/persona";
import LoopOverview from "./views/LoopOverview";
import Workflow from "./views/Workflow";
import TargetView from "./views/Target";
import Records from "./views/Records";
import Intake from "./views/Intake";
import Compound from "./views/Compound";
import Acquisition from "./views/Acquisition";
import Synthesis from "./views/Synthesis";
import MetricsView from "./views/Metrics";

export default function App() {
  const location = useLocation();
  return (
    <PersonaProvider>
      <NavBar />
      <main className="app-main">
        <div key={location.pathname} className="view-anim">
          <Routes location={location}>
            <Route path="/" element={<LoopOverview />} />
            <Route path="/workflow" element={<Workflow />} />
            <Route path="/target" element={<TargetView />} />
            <Route path="/submit" element={<Intake />} />
            <Route path="/records" element={<Records />} />
            <Route path="/compound/:inchikey" element={<Compound />} />
            <Route path="/acquisition" element={<Acquisition />} />
            <Route path="/synthesis" element={<Synthesis />} />
            <Route path="/metrics" element={<MetricsView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </PersonaProvider>
  );
}
