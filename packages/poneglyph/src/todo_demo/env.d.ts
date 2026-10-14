export {};

declare global {
  interface Env {
    /** Set only with `wrangler secret put TODO_SHARED_PASSPHRASE` for the deployed Worker. */
    TODO_SHARED_PASSPHRASE?: string;
  }
}
