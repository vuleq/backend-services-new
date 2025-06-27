const { build } = require('esbuild');
const { glob } = require('glob');
const fs = require('fs-extra');
const path = require('path');

async function runBuild() {
  console.log('Starting build process...');

  // Clean the dist directory
  await fs.remove('dist');

  // --- Build Functions ---
  const functionEntryPoints = await glob('src/functions/**/index.ts');
  if (functionEntryPoints.length > 0) {
    console.log(`Found ${functionEntryPoints.length} function entry points.`);
    await build({
      entryPoints: functionEntryPoints,
      bundle: true,
      platform: 'node',
      target: 'node22',
      outdir: 'dist/functions',
      outbase: 'src/functions',
      format: 'cjs',
      sourcemap: true,
      external: [],
    }).catch(() => process.exit(1));
    console.log('Functions built successfully.');
  }

  // --- Build Layers ---
  const layerDirs = await glob('layers/*', { onlyDirectories: true });
  if (layerDirs.length > 0) {
    console.log(`Found ${layerDirs.length} layers to build.`);
    for (const layerDir of layerDirs) {
      const layerName = path.basename(layerDir);
      const outDir = path.join('dist', 'layers', layerName, 'nodejs');
      const entryPoint = path.join(layerDir, 'index.ts');

      if (await fs.pathExists(entryPoint)) {
        await build({
          entryPoints: [entryPoint],
          bundle: true,
          platform: 'node',
          target: 'node22',
          outfile: path.join(outDir, 'index.js'),
          format: 'cjs',
          sourcemap: true,
          external: [],
        }).catch(() => process.exit(1));
        console.log(`- Layer '${layerName}' built successfully.`);
      }
    }
  }

  console.log('Build completed successfully!');
}

runBuild();