import { memo } from "react";
import { getIconSvg } from "./iconSvgs";

interface MaterialIconProps {
  name: string;
  className?: string;
  size?: number;
}

export const MaterialIcon = memo(function MaterialIcon({
  name,
  className,
  size = 16,
}: MaterialIconProps) {
  const svgContent = getIconSvg(name);

  if (!svgContent) {
    return (
      <span
        className={className}
        style={{
          width: size,
          height: size,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      />
    );
  }

  const svgWithSize = svgContent.replace("<svg ", `<svg width="${size}" height="${size}" `);

  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
      dangerouslySetInnerHTML={{ __html: svgWithSize }}
    />
  );
});
