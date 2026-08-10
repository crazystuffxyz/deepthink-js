export declare function loadImages(sources: Array<string | {
    path?: string;
    url?: string;
    data?: string;
    base64?: string;
}>): Promise<string[]>;
export declare function describeImages(callChat: any, images: string[], opts?: any): Promise<string>;
export declare function looksVisionCapable(model: string): boolean;
//# sourceMappingURL=images.d.ts.map