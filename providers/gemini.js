// providers/gemini.js
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const GEMINI_APP_URL = "https://gemini.google.com/app";
const GEMINI_STREAM_GENERATE_URL =
    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GEMINI_UPLOAD_URL = "https://content-push.googleapis.com/upload";
const GEMINI_UPLOAD_PUSH_ID = "feeds/mcudyrk2a4khkz";
const GOOGLE_LIST_ACCOUNTS_URL =
    "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&laf=b64bin&json=standard";

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MODEL_HEADER_NAME = "x-goog-ext-525001261-jspb";
const MODEL_HEADERS = {
    "3.0 Pro": '[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4],null,null,1]',
    "3.0 Flash": '[1,null,null,null,"fbb127bbb056c959",null,null,0,[4],null,null,1]',
    "3.0 Flash Thinking": '[1,null,null,null,"5bf011840784117a",null,null,0,[4],null,null,1]',
    "3.0 Pro Plus": '[1,null,null,null,"e6fa609c3fa255c0",null,null,0,[4],null,null,4]',
    "3.0 Flash Plus": '[1,null,null,null,"56fdd199312815e2",null,null,0,[4],null,null,4]',
    "3.0 Flash Thinking Plus": '[1,null,null,null,"e051ce1aa80aa576",null,null,0,[4],null,null,4]',
    "3.0 Pro Advanced": '[1,null,null,null,"e6fa609c3fa255c0",null,null,0,[4],null,null,2]',
    "3.0 Flash Advanced": '[1,null,null,null,"56fdd199312815e2",null,null,0,[4],null,null,2]',
    "3.0 Flash Thinking Advanced": '[1,null,null,null,"e051ce1aa80aa576",null,null,0,[4],null,null,2]'
};

const REQUIRED_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

/**
 * Build a cookie header string from a cookie map object.
 * @param {Record<string, string>} cookieMap
 * @returns {string}
 */
function buildCookieHeader(cookieMap) {
    return Object.entries(cookieMap)
        .filter(([, value]) => typeof value === "string" && value.length > 0)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
}

/**
 * Safely index into a nested array by a path of numeric indices.
 * @param {unknown} value
 * @param {number[]} pathParts
 * @returns {unknown}
 */
function getNestedValue(value, pathParts) {
    let current = value;
    for (const part of pathParts) {
        if (current == null) return undefined;
        if (!Array.isArray(current)) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Trim everything before the first "[" and after the last "]" in a string.
 * @param {string} text
 * @returns {string}
 */
function trimJsonEnvelope(text) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
        throw new Error("Gemini response did not contain a JSON payload.");
    }
    return text.slice(start, end + 1);
}

/**
 * Extract a numeric error code from a parsed Gemini response JSON.
 * @param {unknown} responseJson
 * @returns {number | undefined}
 */
function extractErrorCode(responseJson) {
    const code = getNestedValue(responseJson, [0, 5, 2, 0, 1, 0]);
    return typeof code === "number" && code >= 0 ? code : undefined;
}

/**
 * Returns true if the error code indicates the requested model is unavailable.
 * @param {number | undefined} errorCode
 * @returns {boolean}
 */
function isModelUnavailable(errorCode) {
    return errorCode === 1052;
}

/**
 * Decode common email escape sequences in a string.
 * @param {string} value
 * @returns {string}
 */
function decodeEmailEscapes(value) {
    return value
        .replace(/\\u0040/gi, "@")
        .replace(/\\x40/gi, "@")
        .replace(/&#64;/gi, "@")
        .replace(/&commat;/gi, "@")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}

/**
 * Validate and normalize an email string, returning null if invalid.
 * @param {string | undefined} value
 * @returns {string | null}
 */
function normalizeEmail(value) {
    if (!value) return null;
    const normalized = decodeEmailEscapes(value.trim());
    return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(normalized)
        ? normalized
        : null;
}

/**
 * Find the first email address pattern in a raw text string.
 * @param {string} text
 * @returns {string | null}
 */
function findFirstEmail(text) {
    const normalized = decodeEmailEscapes(text);
    const match = normalized.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    return match?.[0] ?? null;
}

/**
 * Recursively search a parsed JSON value for an email address string.
 * @param {unknown} value
 * @returns {string | null}
 */
function findEmailInValue(value) {
    if (typeof value === "string") return normalizeEmail(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const email = findEmailInValue(item);
            if (email) return email;
        }
        return null;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) {
            const email = findEmailInValue(item);
            if (email) return email;
        }
    }
    return null;
}

/**
 * Attempt to extract an email from Gemini's app HTML using known field names.
 * @param {string} html
 * @returns {string | null}
 */
function extractEmailFromGeminiHtml(html) {
    const patterns = [
        /"email"\s*:\s*"([^"]+)"/,
        /"displayEmail"\s*:\s*"([^"]+)"/,
        /"identifier"\s*:\s*"([^"]+)"/,
        /"defaultEmail"\s*:\s*"([^"]+)"/,
        /"gaiaIdentifier"\s*:\s*"([^"]+)"/,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        const email = normalizeEmail(match?.[1]);
        if (email) return email;
    }

    return findFirstEmail(html);
}

/**
 * Extract an email from the Google ListAccounts API response text.
 * @param {string} text
 * @returns {string | null}
 */
function extractEmailFromListAccounts(text) {
    const trimmed = text.replace(/^\)\]\}'\s*/, "");
    try {
        return findEmailInValue(JSON.parse(trimmed)) ?? findFirstEmail(trimmed);
    } catch {
        return findFirstEmail(trimmed);
    }
}

/**
 * Fetch a URL manually following redirects while preserving the cookie header.
 * @param {string} url
 * @param {string} cookieHeader
 * @param {number} maxRedirects
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function fetchWithCookieRedirects(url, cookieHeader, maxRedirects, signal) {
    let current = url;
    for (let i = 0; i <= maxRedirects; i++) {
        const res = await fetch(current, {
            headers: { "user-agent": USER_AGENT, cookie: cookieHeader },
            redirect: "manual",
            signal,
        });
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            if (location) {
                current = new URL(location, current).toString();
                continue;
            }
        }
        return await res.text();
    }
    throw new Error(`Too many redirects (>${maxRedirects})`);
}

/**
 * Fetch the Gemini app page and extract the access token (SNlM0e or thykhd).
 * @param {string} cookieHeader
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function fetchAccessToken(cookieHeader, signal) {
    const html = await fetchWithCookieRedirects(GEMINI_APP_URL, cookieHeader, 10, signal);

    for (const key of ["SNlM0e", "thykhd"]) {
        const match = html.match(new RegExp(`"${key}":"(.*?)"`));
        if (match?.[1]) return match[1];
    }

    throw new Error(
        "Unable to authenticate with Gemini. Make sure you're signed into gemini.google.com in a supported Chromium-based browser.",
    );
}

/**
 * Upload a local file to Gemini's content push endpoint.
 * @param {string} filePath
 * @param {string} cookieHeader
 * @param {AbortSignal} signal
 * @returns {Promise<{ id: string, name: string }>}
 */
async function uploadFile(filePath, cookieHeader, signal) {
    const data = readFileSync(filePath);
    const fileName = basename(filePath);
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const header =
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
        Buffer.from(header, "utf-8"),
        data,
        Buffer.from(footer, "utf-8"),
    ]);

    const res = await fetch(GEMINI_UPLOAD_URL, {
        method: "POST",
        headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "push-id": GEMINI_UPLOAD_PUSH_ID,
            "user-agent": USER_AGENT,
            cookie: cookieHeader,
        },
        body,
        signal,
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`File upload failed: ${res.status} (${text.slice(0, 200)})`);
    }

    return { id: await res.text(), name: fileName };
}

/**
 * Build the f.req JSON payload for the StreamGenerate endpoint.
 * @param {string} prompt
 * @param {Array<{ id: string, name: string }>} uploaded
 * @returns {string}
 */
function buildFReqPayload(prompt, uploaded) {
    const promptPayload =
        uploaded.length > 0
            ? [prompt, 0, null, uploaded.map((file) => [[file.id, 1]])]
            : [prompt];
    const innerList = [promptPayload, null, null];
    return JSON.stringify([null, JSON.stringify(innerList)]);
}

/**
 * Combine an optional external AbortSignal with a timeout signal.
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
function withTimeout(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Parse the raw StreamGenerate response text into a result object.
 * @param {string} rawText
 * @returns {{ text: string, errorCode?: number }}
 */
function parseStreamGenerateResponse(rawText) {
    const responseJson = JSON.parse(trimJsonEnvelope(rawText));
    const errorCode = extractErrorCode(responseJson);

    const parts = Array.isArray(responseJson) ? responseJson : [];
    let body = null;

    for (let i = 0; i < parts.length; i++) {
        const partBody = getNestedValue(parts[i], [2]);
        if (!partBody || typeof partBody !== "string") continue;
        try {
            const parsed = JSON.parse(partBody);
            const candidateList = getNestedValue(parsed, [4]);
            if (Array.isArray(candidateList) && candidateList.length > 0) {
                body = parsed;
                break;
            }
        } catch {
        }
    }

    const candidateList = getNestedValue(body, [4]);
    const firstCandidate = Array.isArray(candidateList) ? candidateList[0] : undefined;
    const textRaw = getNestedValue(firstCandidate, [1, 0]);

    let text = textRaw ?? "";
    if (/^http:\/\/googleusercontent\.com\/card_content\/\d+/.test(text)) {
        const alt = getNestedValue(firstCandidate, [22, 0]);
        if (alt) text = alt;
    }

    return { text, errorCode };
}

/**
 * Run a single Gemini Web query attempt with a specific model.
 * @param {string} prompt
 * @param {Record<string, string>} cookieMap
 * @param {string} model
 * @param {string[] | undefined} files
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ text: string, errorCode?: number, errorMessage?: string }>}
 */
async function runGeminiWebOnce(prompt, cookieMap, model, files, timeoutMs, signal) {
    const effectiveSignal = withTimeout(signal, timeoutMs);
    const cookieHeader = buildCookieHeader(cookieMap);
    const accessToken = await fetchAccessToken(cookieHeader, effectiveSignal);

    const uploaded = [];
    if (files) {
        for (const filePath of files) {
            uploaded.push(await uploadFile(filePath, cookieHeader, effectiveSignal));
        }
    }

    const fReq = buildFReqPayload(prompt, uploaded);
    const params = new URLSearchParams();
    params.set("at", accessToken);
    params.set("f.req", fReq);

    const res = await fetch(GEMINI_STREAM_GENERATE_URL, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded;charset=utf-8",
            host: "gemini.google.com",
            origin: "https://gemini.google.com",
            referer: "https://gemini.google.com/",
            "x-same-domain": "1",
            "user-agent": USER_AGENT,
            cookie: cookieHeader,
            [MODEL_HEADER_NAME]: MODEL_HEADERS[model],
        },
        body: params.toString(),
        signal: effectiveSignal,
    });

    const rawText = await res.text();

    if (!res.ok) {
        return { text: "", errorMessage: `Gemini request failed: ${res.status}` };
    }

    try {
        return parseStreamGenerateResponse(rawText);
    } catch (err) {
        let errorCode;
        try {
            const json = JSON.parse(trimJsonEnvelope(rawText));
            errorCode = extractErrorCode(json);
        } catch {
        }
        return {
            text: "",
            errorCode,
            errorMessage: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * Check whether the provided cookie map contains the two required Gemini cookies.
 * Does not make any network requests.
 * @param {Record<string, string>} cookieMap
 * @returns {boolean}
 */
export function isGeminiWebAvailable(cookieMap) {
    return REQUIRED_COOKIES.every(
        (key) => typeof cookieMap[key] === "string" && cookieMap[key].length > 0,
    );
}

/**
 * Retrieve the Google account email currently signed in, by scraping the Gemini
 * app page or falling back to the Google ListAccounts endpoint.
 * @param {Record<string, string>} cookieMap
 * @returns {Promise<string | null>}
 */
export async function getActiveGoogleEmail(cookieMap) {
    const cookieHeader = buildCookieHeader(cookieMap);
    if (!cookieHeader) return null;

    try {
        const html = await fetchWithCookieRedirects(
            GEMINI_APP_URL,
            cookieHeader,
            10,
            AbortSignal.timeout(10000),
        );
        const email = extractEmailFromGeminiHtml(html);
        if (email) return email;
    } catch {
    }

    try {
        const response = await fetchWithCookieRedirects(
            GOOGLE_LIST_ACCOUNTS_URL,
            cookieHeader,
            10,
            AbortSignal.timeout(10000),
        );
        return extractEmailFromListAccounts(response);
    } catch {
        return null;
    }
}

/**
 * Send a prompt to Gemini Web using browser cookies for auth.
 * Automatically falls back to gemini-3.1-flash-lite if the requested model is unavailable.
 *
 * @param {string} prompt - The text prompt to send.
 * @param {Record<string, string>} cookieMap - Must contain __Secure-1PSID and __Secure-1PSIDTS.
 * @param {object} [options]
 * @param {string} [options.model] - One of: "gemini-3-pro", "gemini-2.5-pro", "gemini-3.1-flash-lite". Defaults to "gemini-3.1-flash-lite".
 * @param {string} [options.youtubeUrl] - Optional YouTube URL to include in the prompt.
 * @param {string[]} [options.files] - Optional array of local file paths to upload.
 * @param {AbortSignal} [options.signal] - Optional AbortSignal for cancellation.
 * @param {number} [options.timeoutMs] - Timeout in milliseconds. Defaults to 120000.
 * @returns {Promise<string>} The text response from Gemini.
 */
export async function queryWithCookies(prompt, cookieMap, options = {}) {
    const model =
        options.model && MODEL_HEADERS[options.model] ? options.model : "gemini-3.1-flash-lite";
    const timeoutMs = options.timeoutMs ?? 120000;

    let fullPrompt = prompt;
    if (options.youtubeUrl) {
        fullPrompt = `${fullPrompt}\n\nYouTube video: ${options.youtubeUrl}`;
    }

    const result = await runGeminiWebOnce(
        fullPrompt,
        cookieMap,
        model,
        options.files,
        timeoutMs,
        options.signal,
    );

    if (isModelUnavailable(result.errorCode) && model !== "gemini-3.1-flash-lite") {
        const fallback = await runGeminiWebOnce(
            fullPrompt,
            cookieMap,
            "gemini-3.1-flash-lite",
            options.files,
            timeoutMs,
            options.signal,
        );
        if (fallback.errorMessage) throw new Error(fallback.errorMessage);
        if (!fallback.text) throw new Error("Gemini Web returned empty response (fallback model)");
        return fallback.text;
    }

    if (result.errorMessage) throw new Error(result.errorMessage);
    if (!result.text) throw new Error("Gemini Web returned empty response");
    return result.text;
}

/**
 * Convenience list of supported model names.
 */
export const MODELS = Object.keys(MODEL_HEADERS);