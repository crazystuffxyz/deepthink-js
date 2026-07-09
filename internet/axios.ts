// internet/axios.ts
// axios with an impit-backed adapter for bot-protected sites.
import axios from 'axios';
import { Readable } from 'node:stream';

const impitClientPromise = import('impit').then(({ Impit }) => {
  return new Impit({ browser: 'chrome', ignoreTlsErrors: true });
});

async function impitAdapter(config: Record<string, any>): Promise<any> {
  const impitClient: any = await impitClientPromise;
  try {
    const method = (config.method || 'GET').toUpperCase();
    const fetchHeaders = new Headers();
    if (config.headers) {
      Object.entries(config.headers).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          (value as unknown[]).forEach(v => fetchHeaders.append(key, String(v)));
        } else if (value !== undefined && value !== null) {
          fetchHeaders.set(key, String(value));
        }
      });
    }
    let body = config.data;
    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
      if (typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Readable)) {
        if (Object.prototype.toString.call(body) === '[object Object]') {
          body = JSON.stringify(body);
          if (!fetchHeaders.has('Content-Type')) {
            fetchHeaders.set('Content-Type', 'application/json;charset=utf-8');
          }
        }
      }
    }
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;
    if (config.timeout) {
      timeoutId = setTimeout(() => controller.abort(), config.timeout);
    }
    const fetchOptions: RequestInit = {
      method,
      headers: fetchHeaders,
      body: (method !== 'GET' && method !== 'HEAD') ? body as BodyInit : undefined,
      signal: controller.signal,
      redirect: config.maxRedirects === 0 ? 'manual' : 'follow'
    };
    const response = await impitClient.fetch(config.url, fetchOptions);
    if (timeoutId) clearTimeout(timeoutId);
    const responseType = (config.responseType || 'json').toLowerCase();
    let responseData: unknown;
    if (responseType === 'stream') {
      responseData = response.body ? Readable.fromWeb(response.body) : null;
    } else if (responseType === 'arraybuffer') {
      const ab = await response.arrayBuffer();
      responseData = Buffer.from(ab);
    } else if (responseType === 'text') {
      responseData = await response.text();
    } else {
      const text = await response.text();
      try {
        responseData = text ? JSON.parse(text) : '';
      } catch {
        responseData = text;
      }
    }
    const responseHeaders: Record<string, unknown> = {};
    response.headers.forEach((value: string, key: string) => {
      if (key.toLowerCase() === 'set-cookie') return;
      responseHeaders[key] = value;
    });
    if (typeof response.headers.getSetCookie === 'function') {
      const setCookies = response.headers.getSetCookie();
      if (setCookies && setCookies.length > 0) responseHeaders['set-cookie'] = setCookies;
    } else if (response.headers.has('set-cookie')) {
      const cookieStr = response.headers.get('set-cookie');
      if (cookieStr) responseHeaders['set-cookie'] = cookieStr.split(/,(?=\s*[A-Za-z0-9_-]+\=)/);
    }
    const axiosResponse: Record<string, unknown> = {
      data: responseData,
      status: response.status,
      statusText: response.statusText || 'OK',
      headers: responseHeaders,
      config: config,
      request: { responseUrl: response.url || config.url, res: { responseUrl: response.url || config.url } }
    };
    const validateStatus = config.validateStatus || ((status: number) => status >= 200 && status < 300);
    if (!validateStatus(response.status)) {
      const error: any = new Error(`Request failed with status code ${response.status}`);
      error.config = config;
      error.response = axiosResponse;
      error.isAxiosError = true;
      throw error;
    }
    return axiosResponse;
  } catch (error: unknown) {
    (error as any).config = config;
    (error as any).isAxiosError = true;
    throw error;
  }
}

axios.defaults.adapter = impitAdapter as any;
export default axios;
