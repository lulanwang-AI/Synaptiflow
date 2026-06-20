// Renders a SMILES string to a small <canvas> using smiles-drawer.
import { useEffect, useRef } from "react";
import SmilesDrawer from "smiles-drawer";

interface Props {
  smiles: string;
  width?: number;
  height?: number;
}

// One shared drawer instance is fine; sizes are passed per-draw via options.
export default function StructureCanvas({
  smiles,
  width = 120,
  height = 90,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drawer = new SmilesDrawer.Drawer({
      width,
      height,
      bondThickness: 1.0,
      padding: 6,
      compactDrawing: true,
      terminalCarbons: false,
    });
    SmilesDrawer.parse(
      smiles,
      (tree: unknown) => {
        try {
          drawer.draw(tree, canvas, "light", false);
        } catch {
          drawFallback(canvas, width, height);
        }
      },
      () => {
        drawFallback(canvas, width, height);
      },
    );
  }, [smiles, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        width,
        height,
        background: "#fff",
        border: "1px solid #e2e2e2",
        borderRadius: 4,
      }}
      title={smiles}
    />
  );
}

function drawFallback(canvas: HTMLCanvasElement, w: number, h: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#999";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("structure n/a", w / 2, h / 2);
}
