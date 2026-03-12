const renderer = Bun.spawn(["bun", "x", "vite"], {
  cwd: import.meta.dir + "/..",
  stdio: ["inherit", "inherit", "inherit"],
  env: {
    ...process.env,
    NODE_ENV: "development",
  },
});

async function waitForRenderer(url: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await Bun.sleep(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

try {
  await waitForRenderer("http://127.0.0.1:3000");

  const bundle = await Bun.build({
    entrypoints: ["./electron/main.ts", "./electron/preload.ts"],
    outdir: "./dist/electron",
    target: "node",
    format: "esm",
    sourcemap: "inline",
    external: ["electron"],
    naming: {
      entry: "[dir]/[name].js",
    },
  });

  if (!bundle.success) {
    throw new Error("Failed to build Electron entrypoints");
  }

  const electron = Bun.spawn(["bun", "x", "electron", "./dist/electron/main.js"], {
    cwd: import.meta.dir + "/..",
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "development",
    },
  });

  const exitCode = await electron.exited;
  process.exit(exitCode);
} finally {
  renderer.kill();
  await renderer.exited;
}
