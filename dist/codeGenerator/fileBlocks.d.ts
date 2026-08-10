export declare const FILE_BLOCK_PROMPT = "OUTPUT FORMAT \u2014 MANDATORY. Your output will be parsed by a machine. Deviate from this format and your code will not run.\nTo output a complete file:\n### FILE: filename.ext\n```language\n[complete file contents \u2014 no placeholders, no \"// ... rest of code\", no truncation]\n```\nTo patch only specific lines of an existing file:\n### PATCH: filename.ext\n---FIND---\n[exact original lines to locate \u2014 must match character-for-character]\n---REPLACE---\n[replacement lines]\n---END---\nSTRICT RULES:\n1. \"### FILE:\" and \"### PATCH:\" headers must be on their own lines, no leading spaces.\n2. The filename must be exact \u2014 correct extension, no spaces, matching what was previously defined.\n3. Every code block must start with a language tag (js, python, json, etc).\n4. Output COMPLETE file contents \u2014 never use \"// TODO\", \"# ...\", \"// rest of code here\" or any placeholder.\n5. Do NOT wrap output in any outer code fence or prose block.\n6. Do NOT output anything outside of ### FILE or ### PATCH blocks except a single line of brief context if needed.\n7. NEVER use external image URLs \u2014 always use inline SVGs for all icons and graphics.\n8. NEVER use base64-encoded images without code execution to generate them \u2014 use SVG only.\n9. All href/src attributes for internal resources must use relative paths only.";
export declare function parseFilesFromResponse(content: string): Record<string, string>;
export declare function applyPatchBlocks(content: string, files: Record<string, string>): Record<string, string>;
export declare function checkSyntaxAST(filePath: string): {
    valid: boolean;
    error: string | null;
};
export declare function detectExternalImages(files: Record<string, string>): Array<{
    file: string;
    type: string;
    match: string;
}>;
export declare function detectBrokenLinks(files: Record<string, string>): Array<{
    file: string;
    type: string;
    ref: string;
}>;
export declare function generateAutomationScript(files: Record<string, string>, architecture: any, task: string): string;
//# sourceMappingURL=fileBlocks.d.ts.map