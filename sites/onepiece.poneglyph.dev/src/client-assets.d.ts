declare module "virtual:playground-client" {
  const assets: Readonly<Record<string, { type: string; etag: string; text?: string; base64?: string }>>;
  export default assets;
}
