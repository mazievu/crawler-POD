const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const codemapsDir = path.join(repoRoot, 'codemaps');
const indexJsonPath = path.join(codemapsDir, 'index.json');

function exitError(msg) {
  console.error(`❌ Validation Failed: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(codemapsDir)) exitError('codemaps/ directory is missing');
if (!fs.existsSync(indexJsonPath)) exitError('codemaps/index.json is missing');

const subDirs = ['phases', 'modules', 'api', 'database', 'exceptions'];
for (const sub of subDirs) {
  if (!fs.existsSync(path.join(codemapsDir, sub))) {
    exitError(`codemaps/${sub}/ directory is missing`);
  }
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(indexJsonPath, 'utf8'));
} catch (err) {
  exitError(`Invalid JSON in codemaps/index.json: ${err.message}`);
}

const requiredKeys = ['phaseMaps', 'moduleMaps', 'apiMaps', 'databaseMaps', 'exceptionMaps', 'trackedFiles', 'acceptanceCommands'];
for (const key of requiredKeys) {
  if (!(key in manifest)) {
    exitError(`Manifest JSON is missing required key: ${key}`);
  }
}

// Verify all referenced paths exist and have substantial content
for (const key of requiredKeys) {
  if (Array.isArray(manifest[key]) && key.endsWith('Maps')) {
    for (const refPath of manifest[key]) {
      const fullPath = path.join(repoRoot, refPath);
      if (!fs.existsSync(fullPath)) {
        exitError(`Referenced file does not exist: ${refPath}`);
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('Placeholder content')) {
        exitError(`File contains placeholder content: ${refPath}`);
      }
      if (content.length < 50) {
        exitError(`File content is suspiciously short: ${refPath}`);
      }
      if (refPath.includes('/phases/') && (!content.includes('## Goal') || !content.includes('## Verification Evidence'))) {
        exitError(`Phase file is missing required headings: ${refPath}`);
      }
      if (refPath.includes('/modules/') && (!content.includes('## Responsibility') || !content.includes('## Public API'))) {
        exitError(`Module file is missing required headings: ${refPath}`);
      }
    }
  }
}

// Check all files in specific directories
const dirsToCheck = [
  'src/channels',
  'src/backends',
  'src/router',
  'src/doctor',
  'src/normalize',
  'skills/crawler-pod',
];

function getAllFiles(dir, fileList = []) {
  const fullPath = path.join(repoRoot, dir);
  if (!fs.existsSync(fullPath)) return fileList;
  
  const files = fs.readdirSync(fullPath);
  for (const file of files) {
    const filePath = path.join(fullPath, file);
    if (fs.statSync(filePath).isDirectory()) {
      getAllFiles(path.join(dir, file), fileList);
    } else {
      fileList.push(path.join(dir, file).replace(/\\/g, '/'));
    }
  }
  return fileList;
}

const recordedFiles = new Set(manifest.trackedFiles.map(f => f.replace(/\\/g, '/')));

let missingFiles = [];
for (const dir of dirsToCheck) {
  const files = getAllFiles(dir);
  for (const f of files) {
    if (!recordedFiles.has(f)) {
      missingFiles.push(f);
    }
  }
}

if (!recordedFiles.has('scripts/e2e-test.js')) {
  missingFiles.push('scripts/e2e-test.js');
}

if (missingFiles.length > 0) {
  exitError(`The following files exist in the project but are NOT recorded in the codemap files array:\n  ${missingFiles.join('\n  ')}`);
}

console.log(`✅ CodeMap Validation Passed! Name: ${manifest.name}, Version: ${manifest.version}`);
process.exit(0);
