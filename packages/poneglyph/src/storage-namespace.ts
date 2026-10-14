// The request boundary needs fetch capability, not a particular DO class type.
export type FetchNamespace = Readonly<{
  getByName(name: string): Readonly<{
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  }>;
}>;
