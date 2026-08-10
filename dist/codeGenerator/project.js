// codeGenerator/project.ts
// re-exports for direct consumers that want one entry.
export { generateAndRunProject } from './run.js';
export { generateAutomationScript } from './fileBlocks.js';
export { detectExternalImages, detectBrokenLinks, parseFilesFromResponse, applyPatchBlocks } from './fileBlocks.js';
export { staticAnalysisAgent } from './run.js';
