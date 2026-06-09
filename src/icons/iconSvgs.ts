const modules: Record<string, string> = import.meta.glob(
  "../../node_modules/material-icon-theme/icons/*.svg",
  { query: "?raw", eager: true, import: "default" },
) as Record<string, string>;

const svgMap: Record<string, string> = {};
for (const [path, content] of Object.entries(modules)) {
  const name = path.split("/").pop()!.replace(".svg", "");
  svgMap[name] = content;
}

export function getIconSvg(name: string): string | undefined {
  return svgMap[name];
}
