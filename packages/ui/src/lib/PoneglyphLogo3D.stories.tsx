import { PoneglyphLogo3D } from "./PoneglyphLogo3D"

export default {
  title: "Brand/PoneglyphLogo3D",
  component: PoneglyphLogo3D,
}

export const Default = {
  args: {
    size: 140,
    fallbackSrc: "/poneglyph.svg",
  },
}

export const Compact = {
  args: {
    size: 72,
    fallbackSrc: "/poneglyph.svg",
  },
}
