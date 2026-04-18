import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import createDebug from "debug";
import webpack, { type MultiStats } from "webpack";
import { ZipFile } from "yazl";
import { $, chalk } from "zx";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(rootDir, "dist");
const internalDir = path.join(distDir, "internal");
const metadataDir = path.join(internalDir, "metadata");
const pyodideDir = path.join(internalDir, "pyodide");
const wheelsDir = path.join(internalDir, "wheels");
const pythonDir = path.join(internalDir, "python");
const demoDir = path.join(rootDir, "demo");
const demoPublicRuntimeDir = path.join(demoDir, "public", "litellm-pyodide");
const demoDistDir = path.join(demoDir, "dist");
const tempDir = path.join(rootDir, ".tmp", "build");
const downloadedWheelsDir = path.join(tempDir, "wheels-download");
const buildDebug = createDebug("litellmPyodide:build");
const require = createRequire(import.meta.url);
const debugBrowserEntry = require.resolve("debug/src/browser.js");
const pyodideAssetNames = [
  "pyodide.js",
  "pyodide.mjs",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

$.cwd = rootDir;

type WheelCompatibilityEntry = {
  filename: string;
  name: string;
  version: string;
  sha256: string;
  tags: string[];
  compatible: boolean;
  reason?: string;
};

function parseWheelFilename(filename: string) {
  const basename = filename.replace(/\.whl$/, "");
  const parts = basename.split("-");
  const tags = parts.slice(-3);
  return {
    name: parts[0] ?? basename,
    version: parts[1] ?? "unknown",
    tags,
  };
}

function isCompatibleWheel(tags: string[]) {
  const [pythonTag, abiTag, platformTag] = tags;
  if (abiTag === "none" && platformTag === "any") {
    return { compatible: true };
  }
  if (platformTag?.includes("emscripten") || platformTag?.includes("wasm32")) {
    return { compatible: true };
  }
  return {
    compatible: false,
    reason: `Unsupported wheel tags ${pythonTag}-${abiTag}-${platformTag}`,
  };
}

async function ensureCleanDir(dirPath: string) {
  await rm(dirPath, { recursive: true, force: true });
  await mkdir(dirPath, { recursive: true });
}

async function verifyFile(filePath: string) {
  await stat(filePath);
}

async function sha256File(filePath: string) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function stagePyodideAssets() {
  buildDebug("staging pyodide assets");
  const pyodidePackageDir = path.join(rootDir, "node_modules", "pyodide");
  await mkdir(pyodideDir, { recursive: true });

  for (const assetName of pyodideAssetNames) {
    const source = path.join(pyodidePackageDir, assetName);
    await verifyFile(source);
    await cp(source, path.join(pyodideDir, assetName));
  }

  await writeFile(
    path.join(pyodideDir, "package.json"),
    '{"type":"commonjs"}\n',
    "utf8",
  );
}

async function stagePythonBridge() {
  buildDebug("staging python bridge");
  await mkdir(pythonDir, { recursive: true });
  const source = path.join(rootDir, "python", "bridge.py");
  await verifyFile(source);
  await cp(source, path.join(pythonDir, "bridge.py"));
}

async function collectFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(entryPath);
      }
      return [entryPath];
    }),
  );
  return files.flat();
}

async function syncDemoRuntimeAssets() {
  buildDebug("syncing runtime assets into demo public directory");
  const workerpoolSource = path.join(
    rootDir,
    "node_modules",
    "workerpool",
    "dist",
    "workerpool.js",
  );
  const vendorDir = path.join(demoPublicRuntimeDir, "vendor");
  const workerpoolBrowserShimPath = path.join(
    vendorDir,
    "workerpool-browser.mjs",
  );

  await stat(distDir);
  await rm(demoPublicRuntimeDir, { recursive: true, force: true });
  await mkdir(demoPublicRuntimeDir, { recursive: true });
  await cp(distDir, demoPublicRuntimeDir, { recursive: true });
  await mkdir(vendorDir, { recursive: true });
  await cp(workerpoolSource, path.join(vendorDir, "workerpool.js"));
  await writeFile(
    workerpoolBrowserShimPath,
    ['import "./workerpool.js";', "export default globalThis.workerpool;"].join(
      "\n",
    ),
    "utf8",
  );

  for (const filePath of await collectFiles(demoPublicRuntimeDir)) {
    if (!filePath.endsWith(".mjs")) {
      continue;
    }

    const relativeShimPath = path
      .relative(path.dirname(filePath), workerpoolBrowserShimPath)
      .replaceAll(path.sep, "/");
    const normalizedShimPath = relativeShimPath.startsWith(".")
      ? relativeShimPath
      : `./${relativeShimPath}`;
    const contents = await readFile(filePath, "utf8");
    const patched = contents
      .replaceAll('from "workerpool"', `from "${normalizedShimPath}"`)
      .replaceAll("from 'workerpool'", `from '${normalizedShimPath}'`);

    if (patched !== contents) {
      await writeFile(filePath, patched, "utf8");
    }
  }
}

async function finalizeDemoBuild() {
  buildDebug("publishing bundled demo service worker");
  const assetsDir = path.join(demoDistDir, "assets");
  const assetNames = await readdir(assetsDir);
  const workerAsset = assetNames.find((fileName) =>
    /^sw-.*\.js$/.test(fileName),
  );

  if (!workerAsset) {
    throw new Error(
      "Could not find the bundled service worker asset in demo/dist/assets.",
    );
  }

  await cp(path.join(assetsDir, workerAsset), path.join(demoDistDir, "sw.js"));
}

async function buildOverlayWheel(overlayPackageDir: string, version: string) {
  buildDebug("building overlay wheel in build.ts", {
    overlayPackageDir,
    version,
  });
  const packageName = "litellm";
  const srcDir = path.join(overlayPackageDir, "src");
  const distInfo = `${packageName}-${version}.dist-info`;
  const wheelName = `${packageName}-${version}-py3-none-any.whl`;
  const wheelPath = path.join(downloadedWheelsDir, wheelName);
  const metadata = [
    "Metadata-Version: 2.1",
    `Name: ${packageName}`,
    `Version: ${version}`,
    "Summary: Pyodide-specific LiteLLM compatibility overlay",
    "Requires-Python: >=3.11",
    "",
  ].join("\n");
  const wheel = [
    "Wheel-Version: 1.0",
    "Generator: litellm-pyodide build.ts",
    "Root-Is-Purelib: true",
    "Tag: py3-none-any",
    "",
  ].join("\n");
  const extraFiles = new Map<string, Buffer>([
    [`${distInfo}/METADATA`, Buffer.from(metadata, "utf8")],
    [`${distInfo}/WHEEL`, Buffer.from(wheel, "utf8")],
    [`${distInfo}/top_level.txt`, Buffer.from("litellm\n", "utf8")],
  ]);
  const records: Array<[string, string, string]> = [];
  const zipFile = new ZipFile();

  for (const filePath of (await collectFiles(srcDir)).sort()) {
    const contents = await readFile(filePath);
    const arcname = path.relative(srcDir, filePath).split(path.sep).join("/");
    zipFile.addBuffer(contents, arcname);
    records.push([
      arcname,
      `sha256=${createHash("sha256").update(contents).digest("hex")}`,
      String(contents.length),
    ]);
  }

  for (const [arcname, contents] of extraFiles) {
    zipFile.addBuffer(contents, arcname);
    records.push([
      arcname,
      `sha256=${createHash("sha256").update(contents).digest("hex")}`,
      String(contents.length),
    ]);
  }

  const recordPath = `${distInfo}/RECORD`;
  const recordContents = Buffer.from(
    [...records, [recordPath, "", ""]]
      .map((row) => row.join(","))
      .join("\n")
      .concat("\n"),
    "utf8",
  );
  zipFile.addBuffer(recordContents, recordPath);

  await new Promise<void>((resolve, reject) => {
    zipFile.outputStream
      .pipe(createWriteStream(wheelPath))
      .on("close", () => resolve())
      .on("error", reject);
    zipFile.end();
  });
}

async function downloadWheelSet() {
  const sourcePath = path.join(rootDir, "python", "wheels-source.json");
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as {
    overlayPackageDir?: string;
    requirements?: string[];
    litellmVersion: string;
  };

  await ensureCleanDir(downloadedWheelsDir);

  if (source.overlayPackageDir) {
    const overlayPackageDir = path.join(rootDir, source.overlayPackageDir);
    await buildOverlayWheel(overlayPackageDir, source.litellmVersion);
    return source;
  }

  if (!source.requirements || source.requirements.length === 0) {
    throw new Error(
      "wheels-source.json must define overlayPackageDir or requirements",
    );
  }

  await $`python3 -m pip download --dest ${downloadedWheelsDir} --only-binary=:all: ${source.requirements}`;

  return source;
}

async function stageWheels() {
  buildDebug("staging wheels");
  const source = await downloadWheelSet();
  await mkdir(wheelsDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });

  const filenames = (await readdir(downloadedWheelsDir)).filter((entry) =>
    entry.endsWith(".whl"),
  );
  const entries: WheelCompatibilityEntry[] = [];

  for (const filename of filenames) {
    const sourcePath = path.join(downloadedWheelsDir, filename);
    const parsed = parseWheelFilename(filename);
    const compatibility = isCompatibleWheel(parsed.tags);
    await cp(sourcePath, path.join(wheelsDir, filename));
    entries.push({
      filename,
      name: parsed.name,
      version: parsed.version,
      sha256: await sha256File(sourcePath),
      tags: parsed.tags,
      compatible: compatibility.compatible,
      reason: compatibility.reason,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    compatible: entries.filter((entry) => entry.compatible),
    incompatible: entries
      .filter((entry) => !entry.compatible)
      .map((entry) => ({ filename: entry.filename, reason: entry.reason })),
  };
  await writeFile(
    path.join(metadataDir, "wheel-compatibility.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  return {
    litellmVersion: source.litellmVersion,
    wheels: entries,
  };
}

async function emitRuntimeManifest({
  litellmVersion,
  wheels,
}: {
  litellmVersion: string;
  wheels: WheelCompatibilityEntry[];
}) {
  buildDebug("writing runtime manifest");
  const packageJson = JSON.parse(
    await readFile(path.join(rootDir, "package.json"), "utf8"),
  ) as {
    version: string;
    devDependencies?: { pyodide?: string };
  };

  const manifest = {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    packageVersion: packageJson.version,
    pyodideVersion:
      packageJson.devDependencies?.pyodide?.replace(/^[^\d]*/, "") ?? "unknown",
    litellmVersion,
    pyodide: {
      indexURL: "./pyodide/",
      modulePath: "./pyodide/pyodide.mjs",
      lockFilePath: "./pyodide/pyodide-lock.json",
    },
    python: {
      bridgePath: "./python/bridge.py",
    },
    wheels: wheels.map((wheel) => ({
      name: wheel.name,
      version: wheel.version,
      filename: wheel.filename,
      sha256: wheel.sha256,
      tags: wheel.tags,
    })),
    reports: {
      compatibilityPath: "./metadata/wheel-compatibility.json",
    },
  };

  await writeFile(
    path.join(internalDir, "runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function createWebpackConfig(
  entry: string,
  filename: string,
  outputPath: string,
  library = false,
): webpack.Configuration {
  return {
    mode: "production",
    target: ["es2022"],
    entry,
    devtool: false,
    experiments: {
      outputModule: true,
    },
    externalsType: "module",
    externals: [/^node:/, { workerpool: "workerpool" }],
    resolve: {
      alias: {
        debug: debugBrowserEntry,
      },
      extensions: [".ts", ".js", ".json"],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: "ts-loader",
            options: {
              compilerOptions: {
                noEmit: false,
              },
              transpileOnly: false,
            },
          },
        },
      ],
    },
    optimization: {
      splitChunks: false,
      runtimeChunk: false,
      minimize: false,
    },
    output: {
      path: outputPath,
      filename,
      library: library ? { type: "module" } : undefined,
      module: true,
      chunkFormat: "module",
      clean: false,
      publicPath: "auto",
      environment: {
        dynamicImport: true,
        module: true,
      },
    },
  };
}

async function runWebpackBuild() {
  buildDebug("running webpack build");
  const compiler = webpack([
    createWebpackConfig(
      path.join(rootDir, "src", "index.ts"),
      "index.mjs",
      distDir,
      true,
    ),
    createWebpackConfig(
      path.join(rootDir, "src", "internal", "worker.ts"),
      "worker.mjs",
      path.join(distDir, "internal"),
    ),
  ]);

  await new Promise<void>((resolve, reject) => {
    compiler.run(
      (error: Error | null | undefined, stats: MultiStats | undefined) => {
        void compiler.close(() => undefined);
        if (error) {
          reject(error);
          return;
        }
        if (!stats || stats.hasErrors()) {
          reject(
            new Error(
              stats?.toString({ all: false, errors: true }) ??
                "Webpack build failed",
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

async function emitDeclarations() {
  buildDebug("emitting declarations");
  await $`${path.join(rootDir, "node_modules", ".bin", "tsc")} --project tsconfig.build.json`;
}

async function main() {
  const supportedModes = new Set([
    "build",
    "demo-sync-runtime",
    "finalize-demo-build",
  ]);
  const mode =
    [...process.argv].reverse().find((arg) => supportedModes.has(arg)) ??
    "build";

  if (mode === "demo-sync-runtime") {
    await syncDemoRuntimeAssets();
    console.log(
      chalk.yellow("Synced runtime assets into demo/public/litellm-pyodide."),
    );
    return;
  }

  if (mode === "finalize-demo-build") {
    await finalizeDemoBuild();
    console.log(
      chalk.yellow("Published demo/dist/sw.js from the bundled worker asset."),
    );
    return;
  }

  console.log(chalk.blue("Building litellm-pyodide..."));

  await ensureCleanDir(distDir);
  await ensureCleanDir(tempDir);
  await mkdir(internalDir, { recursive: true });

  await runWebpackBuild();
  await stagePyodideAssets();
  await stagePythonBridge();
  const wheelInfo = await stageWheels();
  await emitRuntimeManifest(wheelInfo);
  await emitDeclarations();

  console.log(
    chalk.yellow(
      "Build completed. Check dist/internal/metadata/wheel-compatibility.json for the resolved wheel compatibility report.",
    ),
  );
}

main().catch((error) => {
  console.error(chalk.red("Build failed with error:"));
  console.error(error);
  process.exit(1);
});
