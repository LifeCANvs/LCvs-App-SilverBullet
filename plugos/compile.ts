import { denoPlugins, esbuild, path, YAML } from "./deps.ts";

import { bundleAssets } from "./asset_bundle/builder.ts";
import { Manifest } from "./types.ts";

export type CompileOptions = {
  debug?: boolean;
  imports?: Manifest<any>[];
  importMap?: string;
  // Reload plug import cache
  reload?: boolean;
  // Print info on bundle size
  info?: boolean;
};

export async function compileManifest(
  manifestPath: string,
  destPath: string,
  options: CompileOptions = {},
): Promise<string> {
  const rootPath = path.dirname(manifestPath);
  const manifest = YAML.parse(
    await Deno.readTextFile(manifestPath),
  ) as Manifest<any>;

  if (!manifest.name) {
    throw new Error(`Missing 'name' in ${manifestPath}`);
  }

  // Assets
  const assetsBundle = await bundleAssets(
    path.resolve(rootPath),
    manifest.assets as string[] || [],
  );
  manifest.assets = assetsBundle.toJSON();

  const jsFile = `
import { setupMessageListener } from "${new URL(
    "./worker_runtime.ts",
    import.meta.url,
  )}";

// Imports
${
    Object.entries(manifest.functions).map(([funcName, def]) => {
      if (!def.path) {
        return "";
      }
      let [filePath, jsFunctionName] = def.path.split(":");
      // Resolve path
      filePath = path.join(rootPath, filePath);

      return `import {${jsFunctionName} as ${funcName}} from "file://${
        // Replacaing \ with / for Windows
        path.resolve(filePath).replaceAll(
          "\\",
          "\\\\",
        )}";\n`;
    }).join("")
  }

// Function mapping
export const functionMapping = {
${
    Object.entries(manifest.functions).map(([funcName, def]) => {
      if (!def.path) {
        return "";
      }
      return `  ${funcName}: ${funcName},\n`;
    }).join("")
  }
};

const manifest = ${JSON.stringify(manifest, null, 2)};

setupMessageListener(functionMapping, manifest);
`;

  // console.log("Code:", jsFile);

  const inFile = await Deno.makeTempFile({ suffix: ".js" });
  const outFile = `${destPath}/${manifest.name}.plug.js`;
  await Deno.writeTextFile(inFile, jsFile);

  const result = await esbuild.build({
    entryPoints: [path.basename(inFile)],
    bundle: true,
    format: "iife",
    globalName: "mod",
    platform: "browser",
    sourcemap: options.debug ? "linked" : false,
    minify: !options.debug,
    outfile: outFile,
    metafile: options.info,
    // external: esBuildExternals(options.imports),
    treeShaking: true,
    plugins: [
      {
        name: "json",
        setup: (build) =>
          build.onLoad({ filter: /\.json$/ }, () => ({ loader: "json" })),
      },
      ...denoPlugins({
        // TODO do this differently
        importMapURL: options.importMap ||
          new URL("../import_map.json", import.meta.url).toString(),
        loader: "native",
      }),
    ],
    absWorkingDir: path.resolve(path.dirname(inFile)),
  });

  if (options.info) {
    const text = await esbuild.analyzeMetafile(result.metafile!);
    console.log("Bundle info for", manifestPath, text);
  }

  let jsCode = await Deno.readTextFile(outFile);
  jsCode = patchDenoLibJS(jsCode);
  await Deno.writeTextFile(outFile, jsCode);
  console.log(`Plug ${manifest.name} written to ${outFile}.`);
  return outFile;
}

export async function compileManifests(
  manifestFiles: string[],
  dist: string,
  watch: boolean,
  options: CompileOptions = {},
) {
  let building = false;
  dist = path.resolve(dist);
  async function buildAll() {
    if (building) {
      return;
    }
    console.log("Building", manifestFiles);
    building = true;
    Deno.mkdirSync(dist, { recursive: true });
    const startTime = Date.now();
    // Build all plugs in parallel
    await Promise.all(manifestFiles.map(async (plugManifestPath) => {
      const manifestPath = plugManifestPath as string;
      try {
        await compileManifest(
          manifestPath,
          dist,
          options,
        );
      } catch (e) {
        console.error(`Error building ${manifestPath}:`, e);
      }
    }));
    console.log(`Done building plugs in ${Date.now() - startTime}ms`);
    building = false;
  }

  await buildAll();

  if (watch) {
    console.log("Watching for changes...");
    const watcher = Deno.watchFs(manifestFiles.map((p) => path.dirname(p)));
    for await (const event of watcher) {
      if (event.paths.length > 0) {
        if (event.paths[0].endsWith(".json")) {
          continue;
        }
      }
      console.log("Change detected, rebuilding...");
      buildAll();
    }
  }
}

export function patchDenoLibJS(code: string): string {
  // The Deno std lib has one occurence of a regex that Webkit JS doesn't (yet parse), we'll strip it because it's likely never invoked anyway, YOLO
  return code.replaceAll("/(?<=\\n)/", "/()/");
}
