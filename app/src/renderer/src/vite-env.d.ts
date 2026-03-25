declare module "*.css" {
  const stylesheet: string;
  export default stylesheet;
}

declare module "*.svg" {
  const assetUrl: string;
  export default assetUrl;
}

declare module "three";

interface PoneglyphDesktopBridge {
  platform: string;
  version: string;
  apiBaseUrl: string;
}

declare global {
  interface Window {
    poneglyph: PoneglyphDesktopBridge;
  }
}

export {};
