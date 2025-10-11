import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { getSAPCredentials } from './secrets';

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  data?: any;
  timeout?: number;
  params?: Record<string, any>;
}

export interface HttpResponse<T = any> {
  success: boolean;
  data?: T;
  status?: number;
  statusText?: string;
  headers?: Record<string, any>;
  error?: string;
}

export async function makeHttpRequest<T = any>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
  try {
    const config: AxiosRequestConfig = {
      url: options.url,
      method: options.method || 'GET',
      headers: options.headers,
      data: options.data,
      params: options.params,
      timeout: options.timeout || 30000,
      validateStatus: (status) => status < 500
    };

    const response: AxiosResponse<T> = await axios(config);

    return {
      success: response.status >= 200 && response.status < 300,
      data: response.data,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'HTTP request failed',
      status: error.response?.status,
      statusText: error.response?.statusText
    };
  }
}

export async function httpGet<T = any>(url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}): Promise<HttpResponse<T>> {
  return makeHttpRequest<T>({ ...options, url, method: 'GET' });
}

export async function httpPost<T = any>(url: string, data?: any, options: Omit<HttpRequestOptions, 'url' | 'method' | 'data'> = {}): Promise<HttpResponse<T>> {
  return makeHttpRequest<T>({ ...options, url, method: 'POST', data });
}

export async function httpPut<T = any>(url: string, data?: any, options: Omit<HttpRequestOptions, 'url' | 'method' | 'data'> = {}): Promise<HttpResponse<T>> {
  return makeHttpRequest<T>({ ...options, url, method: 'PUT', data });
}

export async function httpDelete<T = any>(url: string, options: Omit<HttpRequestOptions, 'url' | 'method'> = {}): Promise<HttpResponse<T>> {
  return makeHttpRequest<T>({ ...options, url, method: 'DELETE' });
}

export async function getSAPHeaders(): Promise<Record<string, string>> {
  try {
    const { SAP_USER_NAME, SAP_PASSWORD } = await getSAPCredentials();
    
    return {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${Buffer.from(`${SAP_USER_NAME}:${SAP_PASSWORD}`).toString('base64')}`
    };
  } catch (error: any) {
    console.error('Failed to get SAP headers:', error);
    throw new Error(`Get SAP header failed: ${error.message}`);
  }
}
