// 3-D docked-pose viewer (DiffDock). Fetches a 3-D conformer/pose from the
// backend (RDKit mock conformer, or a live DiffDock pose) and renders it with
// 3Dmol.js (WebGL). When a folded receptor structure is available (AlphaFold2),
// it is overlaid as a cartoon with the ligand in ball-and-stick. Falls back to
// the 2-D structure when no 3-D is available (pure offline mock). Lazy-loaded so
// 3Dmol ships in its own chunk.
import { useEffect, useRef, useState } from "react";
import * as $3Dmol from "3dmol";
import { api } from "../api/client";
import type { Target } from "../api/types";
import StructureCanvas from "./StructureCanvas";
import { fmtNum } from "../lib/format";

interface Props {
  smiles: string;
  target?: Target | null;
  confidence?: number | null;
  pocket?: number[];
  onClose: () => void;
}

export default function PoseViewer({ smiles, target, confidence, pocket, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [sdf, setSdf] = useState<string | null>(null);
  const [receptorPdb, setReceptorPdb] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // fetch the 3-D pose (+ receptor structure when a target is supplied)
  useEffect(() => {
    let cancelled = false;
    api
      .pose(smiles, target ?? undefined)
      .then((r) => {
        if (!cancelled) {
          setSdf(r.sdf ?? null);
          setReceptorPdb(r.receptor_pdb ?? null);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [smiles, target]);

  // render with 3Dmol once structure data is ready
  useEffect(() => {
    const host = hostRef.current;
    if (!host || (!sdf && !receptorPdb)) return;
    host.innerHTML = "";
    const viewer = $3Dmol.createViewer(host, { backgroundColor: "#0b1020" });
    if (receptorPdb) {
      const rec = viewer.addModel(receptorPdb, "pdb");
      rec.setStyle({}, { cartoon: { color: "spectrum" }, line: { opacity: 0.25 } });
    }
    if (sdf) {
      const lig = viewer.addModel(sdf, "sdf");
      lig.setStyle({}, { stick: { radius: 0.16, colorscheme: "Jmol" }, sphere: { scale: 0.28 } });
    }
    viewer.zoomTo();
    viewer.spin("y", 1);
    viewer.render();
    viewer.resize();
    return () => {
      try {
        viewer.clear();
      } catch {
        /* noop */
      }
    };
  }, [sdf, receptorPdb]);

  // close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const has3d = !!(sdf || receptorPdb);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>Predicted binding pose</strong> <span className="nim-tag">DiffDock</span>
            {receptorPdb && <span className="nim-tag" style={{ marginLeft: 4 }}>AlphaFold2</span>}
            <div className="muted" style={{ fontSize: "0.78rem", marginTop: "0.15rem" }}>
              {confidence != null && <>confidence {fmtNum(confidence, 2)} · </>}
              {pocket && pocket.length > 0 && (
                <>
                  pocket {pocket.slice(0, 6).join(", ")}
                  {pocket.length > 6 ? "…" : ""} ·{" "}
                </>
              )}
              {receptorPdb ? "receptor + ligand" : "3-D ligand conformer"}
            </div>
          </div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="pose-stage">
          <div ref={hostRef} className="pose-host" />
          {loading && (
            <div className="pose-overlay">
              <span className="spinner" /> generating 3-D pose…
            </div>
          )}
          {!loading && !has3d && (
            <div className="pose-overlay" style={{ flexDirection: "column", gap: "0.6rem" }}>
              <StructureCanvas smiles={smiles} width={200} height={150} />
              <span
                className="muted"
                style={{ fontSize: "0.8rem", textAlign: "center", maxWidth: 300, color: "#cbd5e1" }}
              >
                {err
                  ? `3-D pose unavailable: ${err}`
                  : "3-D pose needs the live backend (RDKit/DiffDock). Showing the 2-D structure."}
              </span>
            </div>
          )}
        </div>

        <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.5rem" }}>
          Drag to rotate · scroll to zoom.{" "}
          {receptorPdb
            ? "Receptor is an illustrative folded fragment unless a live AlphaFold2 NIM is configured."
            : "Pose is illustrative (mock 3-D conformer) unless a live DiffDock NIM is configured."}
        </div>
      </div>
    </div>
  );
}
