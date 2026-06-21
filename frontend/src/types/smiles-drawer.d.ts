// Minimal type declarations for the untyped "smiles-drawer" package.
declare module "smiles-drawer" {
  export interface DrawerOptions {
    width?: number;
    height?: number;
    bondThickness?: number;
    padding?: number;
    compactDrawing?: boolean;
    terminalCarbons?: boolean;
    [key: string]: unknown;
  }

  export class Drawer {
    constructor(options?: DrawerOptions);
    draw(
      tree: unknown,
      target: HTMLCanvasElement | string,
      theme?: string,
      infoOnly?: boolean,
    ): void;
  }

  export function parse(
    smiles: string,
    onSuccess: (tree: unknown) => void,
    onError?: (err: unknown) => void,
  ): void;

  const SmilesDrawer: {
    Drawer: typeof Drawer;
    parse: typeof parse;
  };
  export default SmilesDrawer;
}
