import { globToRegExp, path, walk } from "../deps.ts";
import { AssetBundle } from "./bundle.ts";

export async function bundleAssets(
  rootPath: string,
  patterns: string[],
): Promise<AssetBundle> {
  const bundle = new AssetBundle();
  if (patterns.length === 0) {
    return bundle;
  }
  const matchRegexes = patterns.map((pat) => globToRegExp(pat));
  for await (
    const file of walk(rootPath)
  ) {
    const cleanPath = file.path.substring(rootPath.length + 1);
    let match = false;
    // console.log("Considering", rootPath, file.path, cleanPath);
    for (const matchRegex of matchRegexes) {
      if (matchRegex.test(cleanPath)) {
        match = true;
        break;
      }
    }
    if (match) {
      bundle.writeFileSync(cleanPath, await Deno.readFile(file.path));
    }
  }
  return bundle;
}

export async function bundleFolder(
  rootPath: string,
  bundlePath: string,
) {
  const bundle = new AssetBundle();
  await Deno.mkdir(path.dirname(bundlePath), { recursive: true });
  for await (
    const { path: filePath } of walk(rootPath, { includeDirs: false })
  ) {
    console.log("Bundling", filePath);
    const cleanPath = filePath.substring(`${rootPath}/`.length);
    bundle.writeFileSync(
      cleanPath,
      await Deno.readFile(filePath),
    );
  }
  await Deno.writeTextFile(
    bundlePath,
    JSON.stringify(bundle.toJSON(), null, 2),
  );
}
