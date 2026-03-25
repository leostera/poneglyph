import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  schema: "../crates/poneglyph-api/schema.graphql",
  documents: ["src/**/*.{ts,tsx}", "!src/lib/graphql/generated/**/*"],
  ignoreNoDocuments: false,
  generates: {
    "src/lib/graphql/generated/": {
      preset: "client",
      config: {
        useTypeImports: true,
      },
    },
  },
};

export default config;
