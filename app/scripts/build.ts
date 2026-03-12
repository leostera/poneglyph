const renderer = Bun.spawn(["bun", "x", "vite", "build"], {
  cwd: `${import.meta.dir}/..`,
  stdio: ["inherit", "inherit", "inherit"],
});

const rendererExitCode = await renderer.exited;

if (rendererExitCode !== 0) {
  process.exit(rendererExitCode);
}

const bundle = await Bun.build({
  entrypoints: ["./electron/main.ts", "./electron/preload.ts"],
  outdir: "./dist/electron",
  target: "node",
  format: "esm",
  external: ["electron"],
  naming: {
    entry: "[dir]/[name].js",
  },
});

if (!bundle.success) {
  process.exit(1);
}
